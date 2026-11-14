#define _GNU_SOURCE
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/wait.h>
#include <signal.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Only unreaped children of this subreaper are signalled; sessions and UIDs are irrelevant. */
static int kill_children(void) {
  DIR *directory = opendir("/proc");
  if (!directory) return -1;
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    char *end;
    long pid = strtol(entry->d_name, &end, 10);
    if (*end || pid <= 0) continue;
    char path[64], line[4096];
    snprintf(path, sizeof(path), "/proc/%ld/stat", pid);
    FILE *file = fopen(path, "r");
    if (!file) continue;
    char *read = fgets(line, sizeof(line), file);
    fclose(file);
    if (!read) continue;
    char *name_end = strrchr(line, ')');
    char state;
    long parent;
    if (name_end && sscanf(name_end + 1, " %c %ld", &state, &parent) == 2 && parent == getpid())
      kill((pid_t)pid, SIGKILL);
  }
  closedir(directory);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2 || prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) return 125;
  sigset_t signals;
  sigemptyset(&signals);
  sigaddset(&signals, SIGCHLD);
  sigaddset(&signals, SIGTERM);
  sigaddset(&signals, SIGINT);
  if (sigprocmask(SIG_BLOCK, &signals, NULL) != 0) return 125;
  int fd = signalfd(-1, &signals, SFD_CLOEXEC);
  if (fd < 0) return 125;
  pid_t main_pid = fork();
  if (main_pid < 0) return 125;
  if (main_pid == 0) {
    sigprocmask(SIG_UNBLOCK, &signals, NULL);
    setpgid(0, 0);
    execvp(argv[1], argv + 1);
    dprintf(STDERR_FILENO, "u4-build: command could not start\n");
    _exit(125);
  }
  int main_status = 0, main_exited = 0, stopping = 0, cancel_signal = 0;
  for (;;) {
    int status;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
      if (pid == main_pid) { main_status = status; main_exited = 1; stopping = 1; }
    }
    if (pid < 0 && errno == ECHILD) break;
    if (stopping && kill_children() != 0) return 125;
    struct signalfd_siginfo event;
    ssize_t count = read(fd, &event, sizeof(event));
    if (count < 0 && errno == EINTR) continue;
    if (count != sizeof(event)) return 125;
    if (event.ssi_signo == SIGTERM || event.ssi_signo == SIGINT) {
      stopping = 1;
      cancel_signal = (int)event.ssi_signo;
      /* Deliver cancellation to the original child while it remains unreaped. */
      if (!main_exited) kill(main_pid, (int)event.ssi_signo);
    }
  }
  close(fd);
  if (!main_exited) return 125;
  if (cancel_signal || WIFSIGNALED(main_status)) {
    int signal = cancel_signal ? cancel_signal : WTERMSIG(main_status);
    sigprocmask(SIG_UNBLOCK, &signals, NULL);
    kill(getpid(), signal);
    return 128 + signal;
  }
  return WEXITSTATUS(main_status);
}
