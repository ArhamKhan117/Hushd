/**
 * A rough read on whether this device should be spared constant animation:
 * Data Saver is on, or Chrome reports 4 GB of memory or less, or four cores or
 * fewer. Browsers that report no memory figure (Safari, Firefox) count as
 * capable. The landing's moving backgrounds hold still on these devices.
 */
export function isLowEndDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const n = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  if (n.connection?.saveData) return true;
  if (typeof n.deviceMemory !== "number") return false;
  return n.deviceMemory <= 4 || (n.hardwareConcurrency || 8) <= 4;
}

/**
 * Stamps `html.hd-lite` before first paint on those devices, so CSS can drop
 * effects like backdrop blur that cost the most on a cheap phone's GPU.
 */
export const DEVICE_BOOT_SCRIPT = `(function(){try{var n=navigator,c=n.connection,m=n.deviceMemory;if((c&&c.saveData)||(typeof m==='number'&&(m<=4||(n.hardwareConcurrency||8)<=4)))document.documentElement.classList.add('hd-lite')}catch(e){}})()`;
