import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </IconBase>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 6 4-6 4V8Z" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function FaceIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="10" r="4" />
      <path d="M6 20a6 6 0 0 1 12 0" />
    </IconBase>
  );
}

export function GpuIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="5" y="6" width="14" height="12" rx="2" />
      <path d="M9 10h6v4H9z" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h2M3 15h2M19 9h2M19 15h2" />
    </IconBase>
  );
}

export function PrivacyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3 5 6v5c0 4.5 2.9 8.3 7 9.7 4.1-1.4 7-5.2 7-9.7V6l-7-3Z" />
      <path d="M9.5 12.5 11 14l3.5-4" />
    </IconBase>
  );
}

export function WorkflowIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7h10" />
      <path d="m10 3 4 4-4 4" />
      <path d="M20 17H10" />
      <path d="m14 13-4 4 4 4" />
    </IconBase>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 21V9" />
      <path d="m7 14 5-5 5 5" />
      <path d="M5 5h14" />
    </IconBase>
  );
}

export function PlateIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M7 12h2M11 12h2M15 12h2" />
    </IconBase>
  );
}

export function ExportIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3v12" />
      <path d="m17 10-5 5-5-5" />
      <path d="M5 21h14" />
    </IconBase>
  );
}
