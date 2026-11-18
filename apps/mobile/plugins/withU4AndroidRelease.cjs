const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = function withU4AndroidRelease(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("U4 unsigned Android releases require a Groovy app/build.gradle.");
    }

    // Expo's template signs both build types with its debug key; production is signed after build.
    const contents = nextConfig.modResults.contents
      .replace(/^([ \t]*)signingConfigs[ \t]*\{[ \t]*\r?\n[\s\S]*?^\1\}[ \t]*\r?\n/gm, "")
      .replace(/^[ \t]*signingConfig\b[^\r\n]*\r?\n/gm, "");

    if (/\b(?:signingConfigs?|storeFile|storePassword|keyAlias|keyPassword)\b/.test(contents)) {
      throw new Error("U4 unsigned Android release still contains signing configuration.");
    }
    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
