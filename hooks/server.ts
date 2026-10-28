// 「ブラウザで見る」（/miru）の純粋な部分: 起動コマンドとポートの見当を付ける。
// $ を使う部分（curl で確かめる・起動する・開く・状態行の印）は panel.tsx にある（$ は import を跨げないため）。

export const DEFAULT_PORTS = [3000, 5173, 4321, 8080, 8000, 5000, 3001, 4000, 1420];

export type DevPlan = {
  /** 起動コマンド（例: npm run dev）。分からなければ null */
  command: string | null;
  /** 当たってみるポート（可能性の高い順） */
  ports: number[];
};

/** package.json と lockfile の有無から、起動コマンドとポートの候補を決める */
export function planDev(packageJson: string | null, lockfiles: string[], envText: string | null): DevPlan {
  const ports: number[] = [];
  const push = (p: number) => {
    if (p > 0 && p < 65536 && !ports.includes(p)) ports.push(p);
  };
  const envPort = envText ? /^\s*PORT\s*=\s*"?(\d{2,5})"?/m.exec(envText) : null;
  if (envPort) push(Number(envPort[1]));

  let command: string | null = null;
  if (packageJson !== null) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(packageJson);
    } catch {
      pkg = {};
    }
    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const runner = lockfiles.includes("pnpm-lock.yaml") ? "pnpm" : lockfiles.includes("yarn.lock") ? "yarn" : lockfiles.includes("bun.lockb") || lockfiles.includes("bun.lock") ? "bun" : "npm";
    const name = scripts.dev !== undefined ? "dev" : scripts.start !== undefined ? "start" : scripts.serve !== undefined ? "serve" : null;
    if (name !== null) {
      command = runner === "npm" ? `npm run ${name}` : runner === "yarn" ? `yarn ${name}` : `${runner} run ${name}`;
      const script = scripts[name] ?? "";
      const m = /(?:-p|--port)[\s=]+(\d{2,5})/.exec(script);
      if (m) push(Number(m[1]));
    }
    if ("next" in deps) push(3000);
    if ("vite" in deps || "@sveltejs/kit" in deps || "@remix-run/dev" in deps) push(5173);
    if ("astro" in deps) push(4321);
    if ("nuxt" in deps) push(3000);
    if ("@angular/core" in deps) push(4200);
    if ("express" in deps || "fastify" in deps || "hono" in deps) push(3000);
  }
  for (const p of DEFAULT_PORTS) push(p);
  return { command, ports };
}

export const urlOf = (port: number): string => `http://localhost:${port}`;

