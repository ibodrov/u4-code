// U4 Code fork identity. Every value here must differ from official T3 Code so both run side by side
// without sharing state, ports, URL schemes, desktop entries, D-Bus names or update feeds.
export const PRODUCT_BASE_NAME = "U4 Code";
export const PRODUCT_SLUG = "u4code";
export const PRODUCT_HOME_DIR_NAME = ".u4";
export const PRODUCT_HOME_ENV = "U4CODE_HOME";
export const PRODUCT_CLI_COMMAND = "u4";
export const PRODUCT_DEFAULT_PORT = 4773;
export const PRODUCT_REPOSITORY_URL = "https://github.com/ibodrov/u4-code";

export const PRODUCT_APP_ID = "ca.ibodrov.u4code";
export const PRODUCT_DEV_APP_ID = "ca.ibodrov.u4code.dev";
export const PRODUCT_LINUX_WM_CLASS = "ca.ibodrov.U4Code";
export const PRODUCT_LINUX_DESKTOP_ENTRY = "ca.ibodrov.U4Code.desktop";
export const PRODUCT_DEV_LINUX_DESKTOP_ENTRY = "ca.ibodrov.U4Code.Development.desktop";

export const PRODUCT_URL_SCHEME = "u4code";
export const PRODUCT_DEV_URL_SCHEME = "u4code-dev";

export const PRODUCT_USER_DATA_DIR = "u4code";
export const PRODUCT_DEV_USER_DATA_DIR = "u4code-dev";

export const PRODUCT_BOOT_SERVICE_NAME = "u4code";
export const PRODUCT_BOOT_SERVICE_LAUNCHD_LABEL = "ca.ibodrov.u4code.service";

// Upstream credit, not identity: these deliberately name the project U4 Code was forked from.
export const UPSTREAM_PRODUCT_NAME = "T3 Code";
export const UPSTREAM_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";
