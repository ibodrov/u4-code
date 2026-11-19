import Constants from "expo-constants";
import { Platform } from "react-native";

const appVariant = Constants.expoConfig?.extra?.appVariant;

const iosBrandMarkSource =
  appVariant === "development"
    ? require("../../../../assets/dev/blueprint-ios-1024.png")
    : appVariant === "preview"
      ? require("../../../../assets/nightly/nightly-ios-1024.png")
      : require("../../../../assets/prod/black-ios-1024.png");

export const MOBILE_BRAND_MARK_SOURCE =
  Platform.OS === "android"
    ? appVariant === "development"
      ? require("../../../../assets/u4/dev/icon-1024.png")
      : appVariant === "preview"
        ? require("../../assets/u4/preview-icon.png")
        : require("../../../../assets/u4/prod/icon-1024.png")
    : iosBrandMarkSource;
