// 「たま」ペイン: 用語 / 変更 / やったこと の 3 タブを 1 つの右ペインにまとめる
//
// 中身（state）はそれぞれ terms.tsx / changes.tsx / activity.tsx が作る。ここは描くだけ。
//   - 用語     : 1 語 1 行。語を押すと「知ってる」（/terms know を呼ぶ）。説明は折りたたみ
//   - 変更     : Edit / Write ごとに「ファイル名＋やさしい日本語 2 文＋危ない操作の猫」。押すと差分が開く
//   - やったこと: 帯に出た一言の履歴（同じ物は ×n）
// /terms /changes /log はタブを選んでこのペインを開く。

import type { EngineInterface, Register } from "claude-code";
import type { TamacodeChange, TamacodeLogEntry, TamacodeTerms } from "../types/tamacode";
import { CAT, isTurnRunningNow } from "./activity";
import { t } from "./locale";
import { buildSimplePrompt } from "./panel";
import { RISK_FACE, RISK_NOTE } from "./changes";
import { USER_FILE, buildTerms, serializeUser, setUser, withKnown } from "./terms";

export const PANE_ID = "tama";

// $.state の参照。plugin と key はリテラルでないと validate が読めない。
const PANE_TAB = { plugin: "tamacode", key: "paneTab" } as const;
const TERMS = { plugin: "tamacode", key: "terms" } as const;
const TERMS_OPEN = { plugin: "tamacode", key: "termsOpen" } as const;
const CHANGES = { plugin: "tamacode", key: "changes" } as const;
const OPEN_ID = { plugin: "tamacode", key: "openId" } as const;
const LOG = { plugin: "tamacode", key: "log" } as const;
const BUSY = { plugin: "tamacode", key: "isBusy" } as const;
const NOTICE = { plugin: "tamacode", key: "notice" } as const;

const CHANGES_LIMIT = 50;
const LOG_LIMIT = 200;

type Tab = "terms" | "changes" | "log";
const TABS: Array<[Tab, string]> = [
  ["terms", "用語"],
  ["changes", "変更"],
  ["log", "やったこと"],
];

type Dollar = EngineInterface;

const pad2 = (n: number): string => String(n).padStart(2, "0");
const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

async function readTab($: Dollar): Promise<Tab> {
  const got = await $.state.get(PANE_TAB);
  const v = got.value;
  return v === "changes" || v === "log" || v === "terms" ? v : "terms";
}

// 語を「知ってる」にする: 辞書を差し替え、ファイルに保存し、今の用語を拾い直す。
// （$.command.run で /terms know を呼ぶと自分のプラグインのフックは飛ばされて届かないので、ここで直接やる）
async function knowTerm($: Dollar, term: string): Promise<void> {
  const next = withKnown(term);
  setUser(next);
  let home: string | undefined;
  try {
    home = await $.env.get("HOME");
  } catch {
    home = undefined;
  }
  if (home) await $.fs.write(`${home.replace(/[\\/]+$/, "")}/${USER_FILE}`, serializeUser(next));
  const cur = await readTerms($);
  if (cur !== null) await $.state.set(TERMS, buildTerms(cur.answer, cur.outputs, await $.clock.now()));
}

async function readTerms($: Dollar): Promise<TamacodeTerms | null> {
  const got = await $.state.get(TERMS);
  const v = got.value as Partial<TamacodeTerms> | null | undefined;
  if (!v || typeof v !== "object" || !Array.isArray(v.found)) return null;
  return { at: v.at ?? 0, answer: v.answer ?? "", outputs: Array.isArray(v.outputs) ? v.outputs : [], found: v.found };
}

export const register: Register = (on) => {
  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e);
    const tab = await readTab($);

    const tabs = (
      <Box>
        {TABS.map(([id, name], i) => (
          <Box>
            {i > 0 ? <Text dimColor>　</Text> : null}
            <Button
              plain
              key={`tab:${id}`}
              label={id === tab ? `●${name}` : `○${name}`}
              onPress={() => {
                void $.state.set(PANE_TAB, id);
              }}
            />
          </Box>
        ))}
      </Box>
    );

    // ---------- 用語 ----------
    if (tab === "terms") {
      const [cur, openGot, busyGot] = await Promise.all([readTerms($), $.state.get(TERMS_OPEN), $.state.get(BUSY)]);
      const found = cur?.found ?? [];
      const isOpen = openGot.value === true;
      const isBusy = busyGot.value === true && isTurnRunningNow();
      return (
        <Box flexDirection="column" paddingX={1}>
          {tabs}
          <Box marginTop={1}>
            <Text bold>📘 用語（新しい語が上）　</Text>
            {found.length > 0 ? (
              <Button
                plain
                key="terms:toggle"
                label={isOpen ? "説明をたたむ" : "説明を開く"}
                onPress={() => {
                  void $.state.set(TERMS_OPEN, !isOpen);
                }}
              />
            ) : null}
          </Box>
          <Text dimColor>語を押すと「知ってる」になり次から出ません。＊はツールの出力から、†は自分の辞書</Text>
          <Box>
            {isBusy ? (
              <Text dimColor>{t("panel.btn.kantan")}（{t("panel.busy")}）</Text>
            ) : (
              <Button
                key="terms:kantan"
                label={t("panel.btn.kantan")}
                onPress={() => {
                  void (async () => {
                    try {
                      await $.prompt.submit({ text: buildSimplePrompt() });
                    } catch (err) {
                      await $.state.set(NOTICE, { face: CAT.error, text: t("panel.sendFailed", { error: String(err).slice(0, 60) }), at: await $.clock.now() });
                    }
                  })();
                }}
              />
            )}
          </Box>
          {cur === null ? (
            <Box marginTop={1}>
              <Text dimColor>{CAT.sleep} Claude の返事やツールのエラーが出ると、ここに専門用語が並びます。</Text>
            </Box>
          ) : found.length === 0 ? (
            <Box marginTop={1}>
              <Text dimColor>この返事に、辞書にある専門用語はありませんでした。</Text>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {found.map((t) => (
                <Box flexDirection="column">
                  <Box>
                    <Button
                      plain
                      key={`know:${t.term}`}
                      label={t.term}
                      onPress={() => {
                        void knowTerm($, t.term).catch((err) => {
                          $.ui.log(`「知ってる」に失敗（${t.term}）: ${String(err)}`, { to: "debug" });
                        });
                      }}
                    />
                    {t.from === "tool" ? <Text dimColor>＊</Text> : null}
                    {t.isUser ? <Text dimColor>†</Text> : null}
                    {!isOpen ? (
                      <Text dimColor wrap="truncate-end">
                        　{t.meaning}
                      </Text>
                    ) : null}
                  </Box>
                  {isOpen ? (
                    <Box paddingLeft={2}>
                      <Text wrap="wrap">{t.meaning}</Text>
                    </Box>
                  ) : null}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      );
    }

    // ---------- 変更 ----------
    if (tab === "changes") {
      const [cGot, oGot] = await Promise.all([$.state.get(CHANGES), $.state.get(OPEN_ID)]);
      const list = Array.isArray(cGot.value) ? (cGot.value as TamacodeChange[]) : [];
      const openId = typeof oGot.value === "string" ? oGot.value : null;
      return (
        <Box flexDirection="column" paddingX={1}>
          {tabs}
          <Box marginTop={1}>
            <Text bold>📜 変更（新しい順・最大{CHANGES_LIMIT}件）</Text>
          </Box>
          <Text dimColor>押すと元の差分を開閉。{RISK_FACE} は壊れると困る所</Text>
          {list.length === 0 ? (
            <Box marginTop={1}>
              <Text dimColor>{CAT.sleep} まだ変更はありません。</Text>
            </Box>
          ) : (
            list.map((c) => {
              const isOpen = openId === c.id;
              const label = `${c.isRisky ? `${RISK_FACE} ` : ""}${isOpen ? "▾" : "▸"} ${hhmm(c.at)}  ${c.name}  +${c.added}行 −${c.removed}行`;
              const summary = c.summary === null ? (c.isRisky ? RISK_NOTE : "") : `${c.summary}${c.isRisky ? ` ${RISK_NOTE}` : ""}`;
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Button
                    plain
                    key={`row:${c.id}`}
                    label={label}
                    onPress={() => {
                      void $.state.set(OPEN_ID, isOpen ? null : c.id);
                    }}
                  />
                  {summary !== "" ? (
                    <Box paddingLeft={2}>
                      <Text wrap="wrap">{summary}</Text>
                    </Box>
                  ) : null}
                  {isOpen ? (
                    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                      {c.diff === "" ? <Text dimColor>（中身に変化はありませんでした）</Text> : <Code source={c.diff} format="diff" path={c.file} />}
                      {c.isTruncated ? <Text dimColor>…長いので途中まで表示しています</Text> : null}
                    </Box>
                  ) : null}
                </Box>
              );
            })
          )}
        </Box>
      );
    }

    // ---------- やったこと ----------
    const lGot = await $.state.get(LOG);
    const log = Array.isArray(lGot.value) ? (lGot.value as TamacodeLogEntry[]) : [];
    return (
      <Box flexDirection="column" paddingX={1}>
        {tabs}
        <Box marginTop={1}>
          <Text bold>{CAT.idle} やったこと（新しい順・最大{LOG_LIMIT}件）</Text>
        </Box>
        <Text dimColor>同じことが続いたときは ×n にまとめています</Text>
        {log.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor>{CAT.sleep} まだ何もしていません。</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {log.map((l) => (
              <Text wrap="truncate-end">
                <Text dimColor>{hhmm(l.at)} </Text>
                {l.text}
                {l.count > 1 ? <Text dimColor> ×{l.count}</Text> : null}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    );
  });
};
