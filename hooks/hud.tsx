// 雰囲気モード（/kakkoii）: HUD ペインの描画と、オン・オフの切り替え（純粋な部分は vibe.ts）
//
//   - /kakkoii でオン・オフ。やさしい日本語の帯は常に残る（帯に進捗バーが足されるだけ）
//   - 右ペイン「HUD」: 等幅・琥珀色の単色・細い罫線。上段は SESSION / TOKENS / FILES / EDITS / ERRORS（実データ、1 秒ごと）、
//     下段は直近の道具呼び出しのパスとコマンド（新しいものが上）
//   - Desktop では数字と棒を SVG で描き、棒は前回の値からなめらかに動く。端末では文字で描く
// 数字の集計は activity.tsx（tool.call / turn.step / turn.complete）が vibeStats / vibeLog に書く。ここは描くだけ。
// 設定は config/vibe.json（読み込みは changes.tsx の session.start。起動ロゴもそこ）。

import type { EngineInterface, Register } from "claude-code";
import type { TamacodeVibeStats } from "../types/tamacode";
import { CAT } from "./activity";
import { t } from "./locale";
import { EMPTY_STATS, getVibeConfig, hudLines, hudSvg } from "./vibe";

export const HUD_ID = "hud";
const VIBE_ON = { plugin: "tamacode", key: "vibeOn" } as const;
const VIBE_STATS = { plugin: "tamacode", key: "vibeStats" } as const;
const VIBE_LOG = { plugin: "tamacode", key: "vibeLog" } as const;
const STORE_SETTINGS = "settings";

type Dollar = EngineInterface;

let ticker: { cancel: () => void } | null = null;
let prevStats: TamacodeVibeStats = EMPTY_STATS;

async function readStats($: Dollar): Promise<TamacodeVibeStats> {
  const got = await $.state.get(VIBE_STATS);
  const v = got.value as TamacodeVibeStats | null | undefined;
  return v && typeof v === "object" && Array.isArray(v.filesRead) ? v : EMPTY_STATS;
}

async function readOn($: Dollar): Promise<boolean> {
  const got = await $.state.get(VIBE_ON);
  if (typeof got.value === "boolean") return got.value;
  try {
    const saved = (await $.store.get(STORE_SETTINGS)) as { vibe?: boolean } | undefined;
    return saved?.vibe === true;
  } catch {
    return false;
  }
}

async function setOn($: Dollar, on: boolean): Promise<void> {
  await $.state.set(VIBE_ON, on);
  try {
    const saved = ((await $.store.get(STORE_SETTINGS)) as Record<string, unknown> | undefined) ?? {};
    await $.store.set(STORE_SETTINGS, { ...saved, vibe: on });
  } catch (err) {
    $.ui.log(`設定の保存に失敗: ${String(err)}`, { to: "debug" });
  }
}

// 1 秒ごとに描き直す（SESSION の時計と、帯の進捗バーのため）
function startTicker($: Dollar): void {
  if (ticker !== null) return;
  ticker = $.clock.every(1000, () => {
    $.ui.invalidate("ui.render");
  });
}

function stopTicker(): void {
  ticker?.cancel();
  ticker = null;
}

// 起動時・再読み込み時: 雰囲気モードがオンのままなら HUD を開き直す（$ は import を越えられないので、このファイルの中で呼ぶ）
async function reopenHudIfOn($: Dollar): Promise<void> {
  if (!(await readOn($))) return;
  startTicker($);
  try {
    const opened = await $.ui.open({ id: HUD_ID, title: "HUD", columns: getVibeConfig().hudColumns, rows: 24 });
    if (!opened.isPlaced) $.ui.log(`HUD は待機中: ${opened.reason}`, { to: "debug" });
  } catch (err) {
    $.ui.log(`HUD を開けません: ${String(err)}`, { to: "debug" });
  }
}

export const register: Register = (on) => {
  // 人が画面を見ている会話だけ。マッチャー無しの session.start は changes.tsx が持っているので、ここはマッチャー付き
  on("session.start", { isInteractive: true }, async ($, e, next) => {
    try {
      await reopenHudIfOn($);
    } catch (err) {
      $.ui.log(`HUD の開き直しに失敗: ${String(err)}`, { to: "debug" });
    }
    return next(e);
  });

  on("command.run", { command: "kakkoii" }, async ($) => {
    const cur = await readOn($);
    if (cur) {
      await setOn($, false);
      stopTicker();
      try {
        await $.ui.close({ id: HUD_ID });
      } catch (err) {
        $.ui.log(`HUD を閉じられません: ${String(err)}`, { to: "debug" });
      }
      $.ui.invalidate("ui.render");
      return { text: t("vibe.off") };
    }
    await setOn($, true);
    startTicker($);
    const opened = await $.ui.open({ id: HUD_ID, title: "HUD", columns: getVibeConfig().hudColumns, rows: 24 });
    $.ui.invalidate("ui.render");
    return { text: opened.isPlaced ? t("vibe.on") : t("vibe.onWaiting", { reason: opened.reason }) };
  });

  on("ui.render", { component: "Pane", requestId: HUD_ID }, async ($, e) => {
    const cfg = getVibeConfig();
    const [stats, logGot, now] = await Promise.all([readStats($), $.state.get(VIBE_LOG), $.clock.now()]);
    const log = Array.isArray(logGot.value) ? (logGot.value as Array<{ at: number; text: string }>) : [];
    if (await readOn($)) startTicker($);

    // Desktop などの遠い画面は SVG で（棒は前回の値からなめらかに）
    if (e.surface !== "terminal") {
      const { Box, Svg } = $.ui.resolve(e);
      const src = hudSvg(stats, prevStats, now, log, cfg);
      prevStats = stats;
      return (
        <Box paddingX={1}>
          <Svg source={src} alt={`TAMA HUD: ${hudLines(stats, now).join(" / ")}`} width={360} />
        </Box>
      );
    }

    const { Box, Text } = $.ui.resolve(e);
    const color = cfg.color;
    const pad2 = (n: number): string => String(n).padStart(2, "0");
    const hhmmss = (ms: number): string => {
      const d = new Date(ms);
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    };
    return (
      <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={color}>
        <Text color={color} dimColor>
          {CAT.idle} TAMA HUD
        </Text>
        {hudLines(stats, now).map((l) => (
          <Text color={color}>{l}</Text>
        ))}
        <Text color={color} dimColor>
          {"─".repeat(Math.max(8, Math.min(60, e.props.bodyColumns - 4)))}
        </Text>
        {log.length === 0 ? (
          <Text color={color} dimColor>
            {t("vibe.noLog")}
          </Text>
        ) : (
          log.slice(0, cfg.logLines).map((l, i) => (
            <Text color={color} dimColor={i > 0} wrap="truncate-end">
              {hhmmss(l.at)} {l.text}
            </Text>
          ))
        )}
      </Box>
    );
  });
};
