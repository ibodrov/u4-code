# On-demand U4 builds

Run **Build U4 candidates** from the Actions tab of `ibodrov/u4-code`. Select
`main` and enter the U4 version and three Android codes. The workflow uses the
commit at dispatch for both builds. Enter the highest relevant installed or
reserved code as a floor, a higher test code, and a still higher production
code. All four inputs appear in a public workflow. Use 0 as the floor only if
there is no prior code to account for.

```sh
gh workflow run u4-build.yml -R ibodrov/u4-code --ref main \
  -f version="$u4_version" -f android_floor="$u4_floor" \
  -f android_test_code="$u4_test_code" -f android_release_code="$u4_release_code"
gh run list -R ibodrov/u4-code --workflow u4-build.yml
```

The AppImage and Android jobs run separately. A failure in one job leaves the
other job free to finish and upload its artifact.
The Android artifact contains unsigned ARM64 APKs in the production variant.
The lower-code APK provides an upgrade fixture, and the higher-code APK is the
production build candidate. A separate scratch ledger checks this job's codes
but cannot detect codes taken concurrently elsewhere. Use fresh codes and
rebuild if they conflict.

## Download and verify

Both artifacts contain encrypted archives. Decrypt on a machine with the U4
release key's encryption subkey. Downloading requires read access to the
repository.

```sh
gh run download "$run_id" -R ibodrov/u4-code --dir "$download_dir"
find "$download_dir" -name '*.tar.gz.gpg' -print

# Repeat in a fresh directory for each encrypted archive.
gpg --output "$archive" --decrypt "$encrypted_file"
mkdir "$candidate_dir"
tar -xzf "$archive" -C "$candidate_dir"
(cd "$candidate_dir" && sha256sum -c SHA256SUMS)
```

Compare `build-inputs.json` with the intended source SHA, tree, version and run
before using a candidate. Each job verifies its own bundle from that same
commit and tree. The Android codes and each job’s bundle hash are recorded. The candidate checks report packaging results. They do not
establish client acceptance. The workflow does not sign APKs or publish a
release. For private delivery, use the established reservation, build, signing,
and acceptance process. Its signer requires local build paths and completion
receipts. This workflow has no import step into that process.

## Runner and repository settings

Both jobs use the standard GitHub-hosted `ubuntu-24.04` runner for this public
repository. The AppImage still builds in U4’s pinned Debian container. The
Android job installs the pinned JDK, SDK tools and NDK and builds the ARM64
APK on x64. The Android job releases the test build workspace before it
starts the production build. It retains the test APK and its receipt. There
is no shared build cache. Artifacts expire after one day.
Check the owner’s included artifact-storage allowance before dispatch and keep
paid overages disabled. The jobs do not select larger runners.

Before enabling repository Actions, disable each inherited workflow and verify
its state. Keep Actions off if any cannot be verified as disabled. After
enablement, verify that **Build U4 candidates** is the only active workflow and
no unrelated jobs are queued. Detailed build receipts stay on the runner or
in the encrypted archive. Public logs show build status.
