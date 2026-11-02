/* Theme constants shared by the server layout and the client provider. */

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "hushd_theme";

/** Runs in <head> before paint so the right theme lands with no flash. */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_KEY}');if(c!=='light'&&c!=='dark')c='system';var r=c==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):c;var d=document.documentElement;d.dataset.theme=r;d.classList.toggle('dark',r==='dark');d.classList.toggle('light',r==='light')}catch(e){}})()`;

