import type { SVGProps } from "react";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 1072 640" xmlns="http://www.w3.org/2000/svg">
      {/* The U4 wordmark. assets/u4/wordmark.svg is the editable source of these paths. */}
      <path
        d="M0 0H128V416A96 96 0 0 0 224 512A96 96 0 0 0 320 416V0H448V416A224 224 0 0 1 224 640A224 224 0 0 1 0 416Z"
        fill="currentColor"
      />
      <path
        d="M560 0H688V192A64 64 0 0 0 752 256H816A64 64 0 0 0 880 192V0H1008V256H1072V384H1008V640H880V384H752A192 192 0 0 1 560 192Z"
        fill="currentColor"
      />
    </svg>
  );
}
