import { Platform, type ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

const artwork =
  Platform.OS === "android"
    ? {
        label: "U4",
        aspectRatio: 1072 / 640,
        viewBox: "0 0 1072 640",
        // Keep the paths in sync with assets/u4/wordmark.svg.
        paths: [
          "M0 0H128V416A96 96 0 0 0 224 512A96 96 0 0 0 320 416V0H448V416A224 224 0 0 1 224 640A224 224 0 0 1 0 416Z",
          "M560 0H688V192A64 64 0 0 0 752 256H816A64 64 0 0 0 880 192V0H1008V256H1072V384H1008V640H880V384H752A192 192 0 0 1 560 192Z",
        ],
      }
    : {
        label: "T3",
        aspectRatio: 94.3941 / 56.96,
        viewBox: "15.5309 37 94.3941 56.96",
        paths: [
          "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z",
        ],
      };

export function MobileWordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel={artwork.label}
      height={props.height}
      width={props.height * artwork.aspectRatio}
      viewBox={artwork.viewBox}
    >
      {artwork.paths.map((path) => (
        <ThemedPath
          key={path}
          d={path}
          color={props.color}
          colorClassName={props.colorClassName}
          fill="currentColor"
        />
      ))}
    </Svg>
  );
}
