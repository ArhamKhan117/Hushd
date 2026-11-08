"use client";

import { useEffect, useRef } from "react";
import { isLowEndDevice } from "@/lib/device";

/**
 * The flowing field: a slow, domain-warped noise gradient drawn in WebGL, the
 * Hushd take on a mesh gradient. Silver and white swirls with one steel wash
 * low on the right. Colours come from theme tokens (--f-*), so it follows light
 * and dark. Renders at low resolution (it is all soft gradients), animates only
 * while on screen and at 30 frames a second (the drift is slow), holds still
 * under reduced motion and on low-end phones, and falls back to the CSS field
 * underneath if WebGL is unavailable.
 */

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;

const FRAG = `precision mediump float;
uniform vec2 uRes;uniform float uTime;
uniform vec3 cBase,cHi,cMid,cDeep,cTint;
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec2 mod289(vec2 x){return x-floor(x*(1./289.))*289.;}
vec3 permute(vec3 x){return mod289(((x*34.)+1.)*x);}
float snoise(vec2 v){const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);
vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod289(i);
vec3 p=permute(permute(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);m=m*m;m=m*m;
vec3 x=2.*fract(p*C.www)-1.;vec3 h=abs(x)-.5;vec3 ox=floor(x+.5);vec3 a0=x-ox;
m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;return 130.*dot(m,g);}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 p=uv*vec2(uRes.x/uRes.y,1.)*.42;
  float t=uTime*.045;
  vec2 q=vec2(snoise(p+vec2(0.,t)),snoise(p+vec2(5.2,-t*.8)));
  vec2 r=vec2(snoise(p+.85*q+vec2(1.7,9.2)+t*.5),snoise(p+.85*q+vec2(8.3,2.8)-t*.4));
  float f=snoise(p+1.1*r);
  vec3 col=cBase;
  col=mix(col,cMid,smoothstep(-.7,.9,f)*.9);
  col=mix(col,cHi,smoothstep(-.2,.85,r.x));
  col=mix(col,cHi,smoothstep(.1,1.,q.x)*.55);
  col=mix(col,cDeep,smoothstep(.3,1.,-f)*.35);
  float corner=smoothstep(.2,1.1,uv.x*.75+(1.-uv.y)*.7);
  float g=corner*(.6+.4*smoothstep(-.6,.9,q.y));
  col=mix(col,cTint,g*.62);
  float n=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  col+=(n-.5)*(2./255.);
  gl_FragColor=vec4(col,1.);
}`;

function hex(v: string): [number, number, number] {
  const s = v.trim().replace("#", "");
  const n = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const i = parseInt(n.slice(0, 6), 16);
  if (Number.isNaN(i)) return [0.95, 0.95, 0.96];
  return [((i >> 16) & 255) / 255, ((i >> 8) & 255) / 255, (i & 255) / 255];
}

export function FlowField({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
    if (!gl) return;

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "uRes");
    const uTime = gl.getUniformLocation(prog, "uTime");
    const names = ["cBase", "cHi", "cMid", "cDeep", "cTint"] as const;
    const vars = ["--f-a", "--f-hi", "--f-mid", "--f-deep", "--f-t1"];
    const colorLocs = names.map((n) => gl.getUniformLocation(prog, n));

    const readColors = () => {
      const cs = getComputedStyle(canvas);
      vars.forEach((v, i) => gl.uniform3fv(colorLocs[i]!, hex(cs.getPropertyValue(v))));
    };

    const SCALE = 0.25; // soft gradients survive a low-res buffer
    const resize = () => {
      const w = Math.max(2, Math.round(canvas.clientWidth * SCALE));
      const h = Math.max(2, Math.round(canvas.clientHeight * SCALE));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, w, h);
    };

    const still =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches || isLowEndDevice();
    const seed = 40; // start mid-flow so the first frame is already blended
    const FRAME_MS = 1000 / 30;
    let raf = 0;
    let visible = true;
    let last = 0;
    // Time only advances while the field is drawing, so it resumes where it stopped.
    let clock = 0;

    const draw = () => {
      gl.uniform1f(uTime, seed + clock / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const loop = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      const dt = now - last;
      if (dt >= FRAME_MS) {
        clock += Math.min(dt, 100);
        last = now;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    const play = () => {
      if (still || raf || !visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };

    readColors();
    resize();
    draw();
    canvas.style.opacity = "1";
    play();

    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      play();
    });
    io.observe(canvas);
    const onVisibility = () => play();
    document.addEventListener("visibilitychange", onVisibility);
    const mo = new MutationObserver(() => {
      readColors();
      draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 -z-10 ${className}`}>
      <div className="hd-field" />
      <canvas
        ref={ref}
        className="absolute -left-[6%] -top-[6%] h-[112%] w-[112%] opacity-0 blur-[28px] transition-opacity duration-700"
      />
    </div>
  );
}
