/** App icons: 24px grid, 1.5px strokes in currentColor. */
const ic = "h-[18px] w-[18px] shrink-0";

export const icons = {
  trade: (
    <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4.75 19.25h14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5.25 15.5l4.25-4.5 3.25 2.75 6-6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15.25 7.25h3.5v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  desk: (
    <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4.75 8.75h14.5M4.75 15.25h14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 6l-3.25 2.75L8 11.5M16 12.5l3.25 2.75L16 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  deals: (
    <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.75" y="3.75" width="14.5" height="16.5" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  balance: (
    <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.75" y="5.75" width="16.5" height="13.5" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7.25" y="10.25" width="9.5" height="2.75" rx="1.375" fill="currentColor" />
    </svg>
  ),
  prove: (
    <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3.5l7 3v5.25c0 4.1-2.9 7.6-7 8.75-4.1-1.15-7-4.65-7-8.75V6.5l7-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9 12.25l2.1 2.1L15.25 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  makers: (
    <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="8.5" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16.5" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.75 19c.5-2.6 2.4-4.25 4.75-4.25S12.75 16.4 13.25 19M12.75 15.5c.9-.5 2-.75 3.75-.75 2.35 0 4.25 1.65 4.75 4.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  agents: (
    <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5.75" y="7.75" width="12.5" height="10.5" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 7.75V4.5M9.5 13h.01M14.5 13h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3.5 12.5v1.75M20.5 12.5v1.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 3.75v2M12 18.25v2M20.25 12h-2M5.75 12h-2M17.83 6.17l-1.41 1.41M7.58 16.42l-1.41 1.41M17.83 17.83l-1.41-1.41M7.58 7.58L6.17 6.17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  docs: (
    <svg className={ic} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5.75 4.75h9.5l3 3v11.5a1 1 0 0 1-1 1H5.75a1 1 0 0 1-1-1V5.75a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.5 11h7M8.5 14.5h7M8.5 8h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
};
