/**
 * AttributionReceiptPage — 归因回执页（76 · S7-c）。
 *
 * 数据：BFF `/api/v1/attribution/{sessions,receipt}` → proxy `/v3/admin/attribution/*`。
 * 视图模型：`./utils/view-model`（纯函数；68 D1 / K2 / 溢出三条展示硬约束在彼处钉死）。
 *
 * ⚠️ 空态三因**必须区分**（未配置 key / 无数据 / 上游不可达）——"页面能开但空"
 * 不得被读成验收通过。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Select, Text } from 'tea-component';
import { ApiError } from '@/lib/api/base';
import { attributionApi, type ReceiptDto, type SessionSummary } from '@/lib/api/attribution';
import { toReceiptView, type ReceiptView } from './utils/view-model';

type EmptyReason = 'none' | 'no_data' | 'not_configured' | 'unreachable';

function classifyError(err: unknown): { code: string; empty: EmptyReason } {
  const raw = err instanceof ApiError ? (err.rawMessage ?? 'ATTRIBUTION_UNKNOWN_ERROR') : 'ATTRIBUTION_UNKNOWN_ERROR';
  const code = raw.split(':')[0]!.trim();
  if (code === 'ATTRIBUTION_PROXY_NOT_CONFIGURED') return { code, empty: 'not_configured' };
  if (code === 'ATTRIBUTION_PROXY_UNREACHABLE' || code === 'ATTRIBUTION_PROXY_UNAVAILABLE') {
    return { code, empty: 'unreachable' };
  }
  return { code, empty: 'none' };
}

export function AttributionReceiptPage() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [receipt, setReceipt] = useState<ReceiptDto | null>(null);
  const [errorCode, setErrorCode] = useState('');
  const [emptyReason, setEmptyReason] = useState<EmptyReason>('none');
  const [loading, setLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    setErrorCode('');
    setLoading(true);
    try {
      const res = await attributionApi.sessions({ limit: 50 });
      setSessions(res.sessions);
      if (res.sessions.length === 0) {
        setEmptyReason('no_data');
      } else {
        setEmptyReason('none');
        setSelected((prev) => (prev && res.sessions.some((s) => s.session_key === prev) ? prev : res.sessions[0]!.session_key));
      }
    } catch (err) {
      const { code, empty } = classifyError(err);
      setErrorCode(code);
      setEmptyReason(empty);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      try {
        const dto = await attributionApi.receipt({ session_key: selected });
        if (!cancelled) {
          setReceipt(dto);
          setErrorCode('');
        }
      } catch (err) {
        if (!cancelled) {
          const { code, empty } = classifyError(err);
          setErrorCode(code);
          setEmptyReason(empty);
          setReceipt(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const view: ReceiptView | null = useMemo(() => (receipt ? toReceiptView(receipt, t) : null), [receipt, t]);

  // 144 · C3/C4：缺值统一渲染 = "—" + tooltip"未知"（**不得**用 0 / 空串冒充；`R4` 钉）。
  const missingValue = (
    <span title={t('attribution.receipt.unknown')}>{t('attribution.receipt.missingValue')}</span>
  );

  return (
    <Card className="attribution-receipt-page">
      <div style={{ padding: 16 }}>
        <Text theme="strong" style={{ fontSize: 18 }}>
          {t('attribution.receipt.title')}
        </Text>
        <p style={{ color: '#666', marginTop: 4 }}>{t('attribution.receipt.subtitle')}</p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
          <Select
            value={selected}
            onChange={(v) => setSelected(String(v))}
            options={sessions.map((s) => ({ value: s.session_key, text: s.session_key }))}
            placeholder={t('attribution.receipt.selectSession')}
            style={{ minWidth: 320 }}
          />
          <Button onClick={() => void loadSessions()} disabled={loading}>
            {t('attribution.refresh')}
          </Button>
        </div>

        {errorCode !== '' && <Alert type="error">{t(`attribution.error.${errorCode}` as never, errorCode)}</Alert>}
        {errorCode === '' && emptyReason === 'no_data' && <Text>{t('attribution.empty.noData')}</Text>}
        {errorCode === '' && emptyReason === 'not_configured' && <Text>{t('attribution.empty.notConfigured')}</Text>}
        {errorCode === '' && emptyReason === 'unreachable' && <Text>{t('attribution.empty.unreachable')}</Text>}

        {view && (
          <>
            {/* 145 · C1：摘要层（卡片式，位于计数行之上）——"本次应用 N 项团队资产" +
                每项 "语义类：用途短语"（规则模板生成、禁 LLM）+ 三档效果状态（C2）。
                红线二：`已验证` 档不存在（无独立验证器 ⇒ `asset_validated` 禁写）⇒ 文案
                只出现"已采用 / 已校正 / 仅作为背景参考，效果待验证"。 */}
            <div
              style={{
                margin: '12px 0 8px',
                padding: '8px 12px',
                background: '#fafafa',
                border: '1px solid #eee',
                borderRadius: 4,
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 600 }}>{view.summary.title}</div>
              {view.summary.items.length > 0 && (
                <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                  {view.summary.items.map((it) => (
                    <li key={it.asset_id} style={{ marginBottom: 2 }}>
                      {t('attribution.receipt.summary.item', { label: it.label, purpose: it.purpose })}
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ marginTop: 6, color: '#444' }}>{view.summary.effect.text}</div>
              <div style={{ marginTop: 2, color: '#888', fontSize: 12 }}>{view.summary.effectNote}</div>
            </div>
            <div style={{ margin: '8px 0', fontSize: 13, color: '#444' }}>
              <b>{t('attribution.receipt.units')}</b> {view.counts.units}
              {/* 120 · C2：口径差标注（**同一行、紧跟其后、单处**）——当且仅当差额 > 0 时渲染；
                  数字 = units − units_with_created_event（**两个都是服务端给的** ⇒ 不受分页影响，
                  不许用"本页行数"做减法）。 */}
              {view.counts.units > view.counts.units_with_created_event && (
                <>
                  {' '}
                  {t('attribution.receipt.unitsUndisplayable', {
                    count: view.counts.units - view.counts.units_with_created_event,
                  })}
                </>
              )}
              ｜
              <b>{t('attribution.receipt.judged')}</b> {view.counts.judged}｜
              <b>{t('attribution.receipt.used')}</b> {view.counts.used}｜<b>{t('attribution.receipt.corrected')}</b> {view.counts.corrected}｜
              <b>{t('attribution.receipt.pending')}</b> {view.counts.pending}｜<b>{t('attribution.receipt.failed')}</b> {view.counts.failed}
            </div>
            {/* 146 · C1：阶段口径行（显名；词表唯一定义处 = utils/stage-vocabulary.ts）——
                只映射既有载体、不新增事件类型；validated / contributed 不进词表。 */}
            <div style={{ margin: '4px 0 8px', fontSize: 12, color: '#999' }}>{view.stages.text}</div>
            {/* 溢出记账（30 spec 原文口径；C6） */}
            <div style={{ margin: '8px 0', color: view.overflow.pending > 0 ? '#b45309' : '#888' }}>
              {view.overflow.text}
            </div>
            {view.assets.length > 0 && (
              <div style={{ margin: '8px 0', fontSize: 12, color: '#666' }}>
                <div style={{ marginBottom: 4 }}>{t('attribution.receipt.assets')}:</div>
                {/* 144 · C2：资产展开层（并列新增字段；缺值 ⇒ "—" + tooltip"未知"）。
                    C4：使用位置 / 对应改动两格依赖 `142`（变更锚定）⇒ 只留列位 + 空态文案。 */}
                {view.assets.map((a) => (
                  <details
                    key={a.asset_id}
                    style={{ marginBottom: 4, padding: '4px 8px', border: '1px solid #f0f0f0', borderRadius: 4 }}
                  >
                    <summary style={{ cursor: 'pointer' }}>
                      <span style={{ fontFamily: 'monospace' }}>{a.asset_id}</span>
                      {' · '}
                      {a.semanticLabel}
                      {' · '}
                      {a.version ?? missingValue}
                    </summary>
                    <div style={{ marginTop: 4, lineHeight: 1.7 }}>
                      <div>
                        {t('attribution.receipt.asset.name')}: {a.name ?? missingValue}
                      </div>
                      <div>
                        {t('attribution.receipt.asset.semanticType')}: {a.semanticLabel}
                      </div>
                      <div>
                        {t('attribution.receipt.asset.assetType')}: {a.assetType ?? missingValue}
                      </div>
                      <div>
                        {t('attribution.receipt.asset.version')}: {a.version ?? missingValue}
                      </div>
                      <div>
                        {t('attribution.receipt.asset.updatedAt')}:{' '}
                        {a.updatedAt !== null ? new Date(a.updatedAt).toLocaleString() : missingValue}
                      </div>
                      <div>
                        {t('attribution.receipt.asset.source')}: {a.source ?? missingValue}
                      </div>
                      <div>
                        {t('attribution.receipt.asset.verification')}: {t('attribution.receipt.verification.pending')}
                      </div>
                      <div>
                        {t('attribution.receipt.asset.risks')}:{' '}
                        {a.risks.length > 0 ? a.risks.join(' · ') : t('attribution.receipt.risk.none')}
                      </div>
                      <div>
                        {t('attribution.receipt.asset.usage')}:{' '}
                        {a.usageLocations.length > 0
                          ? a.usageLocations.join(' · ')
                          : t('attribution.receipt.anchor.none')}
                      </div>
                      <div>
                        {t('attribution.receipt.asset.changes')}: {a.changes ?? t('attribution.receipt.anchor.none')}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                  <th style={{ padding: 6 }}>{t('attribution.receipt.unit')}</th>
                  <th style={{ padding: 6 }}>{t('attribution.receipt.turn')}</th>
                  <th style={{ padding: 6 }}>{t('attribution.receipt.verdict')}</th>
                  <th style={{ padding: 6 }}>{t('attribution.receipt.markers')}</th>
                  <th style={{ padding: 6 }}>{t('attribution.receipt.events')}</th>
                </tr>
              </thead>
              <tbody>
                {view.units.map((u) => (
                  <tr key={u.unit_id} style={{ borderBottom: '1px solid #f5f5f5' }}>
                    <td style={{ padding: 6, fontFamily: 'monospace' }}>{u.unit_id}</td>
                    <td style={{ padding: 6 }}>{u.turnLabel}</td>
                    <td style={{ padding: 6 }}>{u.verdict ?? '—'}</td>
                    <td style={{ padding: 6 }}>
                      {u.unexecuted && <span style={{ color: '#888' }}>{t('attribution.marker.unexecuted')}</span>}
                      {u.suspectFlags.map((f) => (
                        <span key={f} style={{ color: '#b45309', marginRight: 4 }}>
                          {f}
                        </span>
                      ))}
                      {u.missing.length > 0 && (
                        <span style={{ color: '#999' }}>
                          {t('attribution.receipt.missing')}: {u.missing.join(',')}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: 6 }}>
                      {u.status_events.map((ev) => (
                        <div key={ev.status_id}>
                          {ev.event_type}
                          {/* 146 · C1：阶段显名（未知事件型 ⇒ 不渲染后缀） */}
                          {ev.stageLabel !== undefined && (
                            <span style={{ color: '#888', marginLeft: 4 }}>
                              {t('attribution.receipt.stage.tag', { label: ev.stageLabel })}
                            </span>
                          )}
                          {ev.corrected && (
                            <span style={{ color: '#b45309', marginLeft: 6 }}>
                              {/* 68 D1：检测时间 + "检测时快照"标注（禁止"当前版本"字样） */}
                              {new Date(ev.corrected.detected_at).toLocaleString()} · {ev.corrected.note}
                            </span>
                          )}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.truncated && (
              <div style={{ marginTop: 8, color: '#888' }}>{t('attribution.receipt.truncated')}</div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
