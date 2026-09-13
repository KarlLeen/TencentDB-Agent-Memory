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

  const view: ReceiptView | null = useMemo(() => (receipt ? toReceiptView(receipt) : null), [receipt]);

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
              <b>used</b> {view.counts.used}｜<b>corrected</b> {view.counts.corrected}｜
              <b>pending</b> {view.counts.pending}｜<b>failed</b> {view.counts.failed}
            </div>
            {/* 溢出记账（30 spec 原文口径；C6） */}
            <div style={{ margin: '8px 0', color: view.overflow.pending > 0 ? '#b45309' : '#888' }}>
              {view.overflow.text}
            </div>
            {view.assets.length > 0 && (
              <div style={{ margin: '8px 0', fontSize: 12, color: '#666' }}>
                {t('attribution.receipt.assets')}:
                {view.assets.map((a) => (
                  <span key={a.asset_id} style={{ marginLeft: 8 }}>
                    {a.asset_id} [{a.versions.join('→')}]
                  </span>
                ))}
              </div>
            )}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                  <th style={{ padding: 6 }}>unit</th>
                  <th style={{ padding: 6 }}>{t('attribution.receipt.turn')}</th>
                  <th style={{ padding: 6 }}>verdict</th>
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
                          missing: {u.missing.join(',')}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: 6 }}>
                      {u.status_events.map((ev) => (
                        <div key={ev.status_id}>
                          {ev.event_type}
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
