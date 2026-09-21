import type { SVGProps } from "react";

const paths = {
  chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 1 1 21 11.5ZM7 9h9M7 13h6",
  image: "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM3 17l6-6 4 4 3-3 5 5M17 7h.01",
  refresh: "M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17",
  bolt: "m13 2-9 12h7l-1 8 10-12h-7l1-8Z",
  cycle: "M4 8h13l-3-3m6 11H7l3 3M4 8v5m16 3v-5",
  close: "m6 6 12 12M18 6 6 18",
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2",
  layers: "m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5",
  gauge: "M4 18a9 9 0 1 1 16 0M12 13l4-5M11 17h2",
  check: "m5 12 4 4L19 6",
  search: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6",
  chart: "M4 4v16h16M8 15v-4m4 4V7m4 8v-6",
  folder: "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
  chevron: "m8 10 4 4 4-4",
  moon: "M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z",
  sun: "M12 3V1m0 22v-2M3 12H1m22 0h-2M5.6 5.6 4.2 4.2m15.6 15.6-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z",
} as const;

export type UiIconName = keyof typeof paths;

/** Local vector icons: no network/font dependency and a consistent visual weight. */
export function UiIcon({ name, className = "", ...props }: SVGProps<SVGSVGElement> & { name: UiIconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" className={`neu-icon ${className}`} {...props}>
    <path d={paths[name]} />
  </svg>;
}
