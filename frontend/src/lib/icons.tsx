// Feather-style inline stroke icons (stroke-width ~1.7, currentColor).
type P = { size?: number };
const S = (d: string, size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    {d.split("|").map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

export const Icon = {
  chat: ({ size }: P) => S("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", size),
  calendar: ({ size }: P) => S("M3 4h18v18H3z|M16 2v4|M8 2v4|M3 10h18", size),
  file: ({ size }: P) => S("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6", size),
  check: ({ size }: P) => S("M9 11l3 3L22 4|M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11", size),
  mail: ({ size }: P) => S("M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z|M22 6l-10 7L2 6", size),
  note: ({ size }: P) => S("M4 3h16v18l-4-3-4 3-4-3-4 3z", size),
  plane: ({ size }: P) => S("M22 2L11 13|M22 2l-7 20-4-9-9-4 20-7z", size),
  coffee: ({ size }: P) => S("M18 8h1a4 4 0 0 1 0 8h-1|M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z|M6 1v3|M10 1v3|M14 1v3", size),
  code: ({ size }: P) => S("M16 18l6-6-6-6|M8 6l-6 6 6 6", size),
  grid: ({ size }: P) => S("M3 3h7v7H3z|M14 3h7v7h-7z|M14 14h7v7h-7z|M3 14h7v7H3z", size),
  edit: ({ size }: P) => S("M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z", size),
  cloud: ({ size }: P) => S("M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z", size),
  hash: ({ size }: P) => S("M4 9h16|M4 15h16|M10 3L8 21|M16 3l-2 18", size),
  mic: ({ size }: P) => S("M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z|M19 10v2a7 7 0 0 1-14 0v-2|M12 19v4", size),
  send: ({ size }: P) => S("M12 19V5|M5 12l7-7 7 7", size),
  sparkle: ({ size }: P) => S("M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", size),
  volume: ({ size }: P) => S("M11 5L6 9H2v6h4l5 4z|M15.5 8.5a5 5 0 0 1 0 7|M19 5a9 9 0 0 1 0 14", size),
  mute: ({ size }: P) => S("M11 5L6 9H2v6h4l5 4z|M22 9l-6 6|M16 9l6 6", size),
};
