import { useEffect, useRef } from "react";
import { ORB_COLORS, ThemeName } from "../theme";

export type OrbMode = "listening" | "hearing" | "thinking" | "responding" | "muted";

const LABEL: Record<OrbMode, string> = {
  listening: "LISTENING", hearing: "HEARING YOU", thinking: "THINKING", responding: "RESPONDING", muted: "MUTED",
};
const DOT: Record<OrbMode, string> = {
  listening: "var(--acc)", hearing: "var(--okD)", thinking: "var(--warn)", responding: "var(--acc2)", muted: "var(--mut2)",
};

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const VS = "attribute vec2 p; void main(){ gl_Position = vec4(p,0.0,1.0); }";
const FS = `precision highp float;
uniform float u_time; uniform vec2 u_res; uniform float u_level;
uniform vec3 u_acc; uniform vec3 u_hot; uniform vec3 u_acc2; uniform float u_light; uniform float u_mode;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),u.x), mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),u.x), u.y); }
float fbm(vec2 p){ float v=0.0, a=0.55; for(int i=0;i<4;i++){ v+=a*noise(p); p=p*1.9+vec2(1.7,9.2); a*=0.5; } return v; }
void main(){
  vec2 uv=(gl_FragCoord.xy*2.0-u_res)/u_res.y;
  float r=length(uv); float lv=u_level;
  float t=u_time*(0.14+lv*0.22+step(1.5,u_mode)*0.34);
  float R=0.70+lv*0.02;
  float sph=smoothstep(R+0.008,R-0.014,r);
  float z=sqrt(max(0.0,R*R-r*r))/R;
  vec3 N=normalize(vec3(uv,z*R+0.0001));
  vec2 p=uv/R; vec2 rp=p*(1.0+0.38*(1.0-z));
  float w1=fbm(rp*1.25+vec2(t*0.7,-t*0.5));
  float w2=fbm(rp*1.25-vec2(t*0.45,t*0.6)+w1*1.6);
  float m=fbm(rp*1.05+vec2(w1,w2)*1.9);
  m=smoothstep(0.16,0.86,m+lv*0.16);
  vec3 col=mix(u_acc2,u_acc,smoothstep(0.0,0.55,m));
  col=mix(col,u_hot,smoothstep(0.60,1.0,m));
  col*=0.70+0.52*z;
  float fr=pow(1.0-z,2.6);
  col+=mix(u_acc,u_acc2,0.5)*fr*(0.85+lv*0.8);
  vec3 L=normalize(vec3(-0.35,0.55,0.75));
  float dif=clamp(dot(N,L),0.0,1.0);
  col*=0.64+0.48*dif;
  vec3 H=normalize(L+vec3(0.0,0.0,1.0));
  float spec=pow(clamp(dot(N,H),0.0,1.0),90.0);
  col+=vec3(1.0)*spec*0.9;
  float sheen=pow(clamp(dot(N,normalize(vec3(-0.5,0.8,0.45))),0.0,1.0),8.0);
  col+=vec3(1.0)*sheen*0.12;
  float glow=exp(-5.5*max(0.0,r-R))*(0.15+lv*0.30)*(1.0-u_light*0.25);
  vec3 gcol=mix(u_acc,u_acc2,0.5);
  col=col*sph+gcol*glow*(1.0-sph);
  float a=clamp(sph+glow*0.8*(1.0-sph),0.0,1.0);
  float edge=smoothstep(0.99,0.88,r); a*=edge;
  if(u_mode>0.5&&u_mode<1.5){
    float rip=0.5+0.5*sin(r*30.0-u_time*7.5);
    float rw=exp(-3.2*max(0.0,r-R))*smoothstep(R,R+0.02,r);
    float ri=rip*rw*lv*(0.85-u_light*0.2);
    col+=mix(u_acc,mix(u_hot,u_acc2,u_light),0.55)*ri;
    a=max(a,clamp(ri,0.0,0.9)*edge);
  }
  if(u_mode>1.5){
    float ang=atan(uv.y,uv.x); float ringR=R+0.11;
    float ring=exp(-pow((r-ringR)/0.016,2.0));
    float s1=pow(fract(ang/6.2831853-u_time*0.40),16.0);
    float s2=pow(fract(-ang/6.2831853-u_time*0.27+0.5),16.0);
    float ri=ring*(s1*1.5+s2*1.0+0.11)*(1.0-u_light*0.25);
    col+=mix(u_hot,u_acc2,0.35+0.55*u_light)*ri;
    a=max(a,clamp(ri,0.0,1.0)*edge);
  }
  col*=edge;
  gl_FragColor=vec4(col,a);
}`;

// mode uniform: 0 = calm, 1 = ripples (hearing/responding), 2 = comet arcs (thinking)
function modeUniform(m: OrbMode): number {
  if (m === "thinking") return 2;
  if (m === "hearing" || m === "responding") return 1;
  return 0;
}

export function Orb({ theme, mode, level, name = "LEVI", idleLabel = "READY" }: { theme: ThemeName; mode: OrbMode; level: number; name?: string; idleLabel?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ theme, mode, level });
  stateRef.current = { theme, mode, level };
  const lvlRef = useRef(0);
  const historyRef = useRef<number[]>(new Array(27).fill(0));

  useEffect(() => {
    const canvas = canvasRef.current!;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) return;
    const mk = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    const uT = U("u_time"), uR = U("u_res"), uL = U("u_level"), uA = U("u_acc"), uH = U("u_hot"), uA2 = U("u_acc2"), uLt = U("u_light"), uMd = U("u_mode");
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const start = performance.now();
    let raf = 0;
    const draw = () => {
      const now = (performance.now() - start) / 1000;
      const { theme, mode, level } = stateRef.current;
      const [base, hi, sec] = ORB_COLORS[theme];
      const sim = 0.1 + 0.09 * Math.abs(Math.sin(now * 3.1) + 0.5 * Math.sin(now * 5.7));
      const m = modeUniform(mode);
      const target = mode === "muted" ? 0 : Math.max(level, mode === "responding" ? 0.22 + 0.24 * Math.abs(Math.sin(now * 9) * Math.sin(now * 2.3)) : mode === "listening" ? sim * 0.5 : level);
      lvlRef.current += (target - lvlRef.current) * 0.18;
      const lv = lvlRef.current;
      gl.uniform1f(uT, now); gl.uniform1f(uL, lv);
      const A = rgb(base), Ht = rgb(hi), A2 = rgb(sec);
      gl.uniform3f(uA, A[0], A[1], A[2]); gl.uniform3f(uH, Ht[0], Ht[1], Ht[2]); gl.uniform3f(uA2, A2[0], A2[1], A2[2]);
      gl.uniform1f(uLt, theme === "ivory" ? 1 : 0); gl.uniform1f(uMd, m);
      gl.uniform2f(uR, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // waveform: 27 bars from level history
      const wc = waveRef.current;
      if (wc) {
        const h = historyRef.current; h.push(lv); h.shift();
        const ctx = wc.getContext("2d")!;
        ctx.clearRect(0, 0, wc.width, wc.height);
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--acc").trim() || "#ff9f0a";
        const bw = wc.width / h.length;
        for (let i = 0; i < h.length; i++) {
          const bh = Math.max(2, h[i] * wc.height * 1.8);
          ctx.globalAlpha = 0.25 + 0.75 * (i / h.length);
          ctx.fillStyle = accent;
          const x = i * bw, y = (wc.height - bh) / 2;
          ctx.beginPath();
          (ctx as any).roundRect?.(x + 1, y, bw - 2, bh, 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="orb-assembly">
      <canvas ref={canvasRef} width={300} height={300} style={{ width: 104, height: 104, filter: "var(--orbShadow)" }} />
      <div className="orb-status">
        <span className="dot" style={{ background: DOT[mode], animation: "blink 1.6s infinite" }} />
        {name} · {mode === "muted" ? idleLabel : LABEL[mode]}
      </div>
      <canvas ref={waveRef} width={150} height={22} style={{ width: 130, height: 22 }} />
      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
    </div>
  );
}
