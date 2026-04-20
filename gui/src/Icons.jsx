/* Inline SVG icons — stroke-based, 16x16 viewBox */
const ico = (d, opts = {}) => (
  ({ size = 16, className, style } = {}) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={opts.sw ?? 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  )
);

export const IconHome        = ico('M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
export const IconList        = ico(['M8 6h13','M8 12h13','M8 18h13','M3 6h.01','M3 12h.01','M3 18h.01']);
export const IconCheck       = ico('M20 6L9 17l-5-5');
export const IconRefresh     = ico(['M23 4v6h-6','M1 20v-6h6','M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15']);
export const IconCompare     = ico(['M18 20V10','M12 20V4','M6 20v-6']);
export const IconSearch      = ico(['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z','M21 21l-4.35-4.35']);
export const IconX           = ico(['M18 6L6 18','M6 6l12 12']);
export const IconChevronDown = ico('M6 9l6 6 6-6');
export const IconChevronRight= ico('M9 18l6-6-6-6');
export const IconArrowRight  = ico(['M5 12h14','M12 5l7 7-7 7']);
export const IconTerminal    = ico(['M4 17l6-6-6-6','M12 19h8']);
export const IconPlay        = ico('M5 3l14 9-14 9V3z', { sw: 1.5 });
export const IconSettings    = ico(['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z','M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z']);
export const IconInfo        = ico(['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z','M12 8v4','M12 16h.01']);
export const IconAlertTri    = ico(['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z','M12 9v4','M12 17h.01']);
export const IconCheckCircle = ico(['M22 11.08V12a10 10 0 1 1-5.93-9.14','M22 4L12 14.01l-3-3']);
export const IconXCircle     = ico(['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z','M15 9l-6 6','M9 9l6 6']);
export const IconSun         = ico(['M12 2v2','M12 20v2','M4.22 4.22l1.42 1.42','M18.36 18.36l1.42 1.42','M2 12h2','M20 12h2','M4.22 19.78l1.42-1.42','M18.36 5.64l1.42-1.42','M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z']);
export const IconMoon        = ico('M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z');
export const IconCode        = ico(['M16 18l6-6-6-6','M8 6l-6 6 6 6']);
export const IconPackage     = ico(['M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z','M3.27 6.96L12 12.01l8.73-5.05','M12 22.08V12']);
export const IconGitBranch   = ico(['M6 3v12','M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z','M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z','M18 9a9 9 0 0 1-9 9']);
export const IconCopy        = ico(['M20 9H11a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z','M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 0 2 2v1']);
export const IconDownload    = ico(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4','M7 10l5 5 5-5','M12 15V3']);
export const IconFilter      = ico('M22 3H2l8 9.46V19l4 2v-8.54L22 3z');
export const IconMoreHoriz   = ico(['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z','M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z','M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'], { sw: 2 });
export const IconFileText    = ico(['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z','M14 2v6h6','M16 13H8','M16 17H8','M10 9H8']);
export const IconActivity    = ico('M22 12h-4l-3 9L9 3l-3 9H2');
export const IconCloudDown   = ico(['M8 17l4 4 4-4','M12 12v9','M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29']);
