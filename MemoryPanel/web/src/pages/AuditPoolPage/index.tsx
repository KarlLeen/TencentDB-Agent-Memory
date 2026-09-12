/**
 * AuditPoolPage — 抽查/分歧池页（76 · S7-c）。
 *
 * 数据：BFF `/api/v1/attribution/{pool,review}` → proxy `/v3/admin/attribution/audit-pool|audit-reviews`。
 * 视图模型：`./utils/view-model`（迁移表 / 七类顺序；自迁移禁）。
 *
 * ⚠️ 两个诚实标注：
 *   1. **actor 服务端注入**：前端**不传** actor（BFF 从 x-tdai-user-key 取）；无 user key
 *      （且非 IdP cookie 会话身份可用）时禁用提交并提示——**不匿名**；
 *   2. 池 DTO 无 review 状态读口（S7-b 既有字段不动）⇒ "当前状态" = **本会话内的提交
 *      记录**（缺省 unreviewed），页面明示该口径——服务端仍以迁移表 + prev_status 兜底。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Select, Text } from 'tea-component';
import { ApiError } from '@/lib/api/base';
import { attributionApi, type PoolDto } from '@/lib/api/attribution';
import { getPanelSession } from '@/lib/panelSession';
import {
  allowedTransitions,
  toPoolView,
  type PoolView,
} from './utils/view-model';

export function AuditPoolPage() {
  const { t } = useTranslation();
  const [pool, setPool] = useState<PoolDto | null>(null);
  const [category, setCategory] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [emptyReason, setEmptyReason] = useState<'none' | 'no_data' | 'not_configured' | 'unreachable'>('none');
  // 本会话内的提交记录（audit_key → status）；服务端无状态读口（见头注 2）。
  const [localStatus, setLocalStatus] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');

  const hasUserKey = Boolean(getPanelSession()?.userKey);

  const load = useCallback(async () => {
    setErrorCode('');
    try {
      const dto = await attributionApi.pool(category ? { category, limit: 200 } : { limit: 200 });
      setPool(dto);
      setEmptyReason(dto.items.length === 0 ? 'no_data' : 'none');
    } catch (err) {
      const raw = err instanceof ApiError ? (err.rawMessage ?? 'ATTRIBUTION_UNKNOWN_ERROR') : 'ATTRIBUTION_UNKNOWN_ERROR';
      const code = raw.split(':')[0]!.trim();
      setErrorCode(code);
      setEmptyReason(
        code === 'ATTRIBUTION_PROXY_NOT_CONFIGURED'
          ? 'not_configured'
          : code === 'ATTRIBUTION_PROXY_UNREACHABLE' || code === 'ATTRIBUTION_PROXY_UNAVAILABLE'
            ? 'unreachable'
            : 'none',
      );
      setPool(null);
    }
  }, [category]);

  useEffect(() => {
    void load();
  }, [load]);

  const view: PoolView | null = useMemo(() => (pool ? toPoolView(pool) : null), [pool]);
  const currentOf = (auditKey: string): string => localStatus[auditKey] ?? 'unreviewed';

  const submit = useCallback(
    async (auditKey: string) => {
      const target = targets[auditKey];
      if (!target || !hasUserKey) return;
      const prev = currentOf(auditKey);
      try {
        const res = await attributionApi.review({
          audit_key: auditKey,
          prev_status: prev,
          status: target,
          note: notes[auditKey]?.trim() || undefined,
        });
        setLocalStatus((m) => ({ ...m, [auditKey]: res.status }));
        setFeedback(t('attribution.pool.submitOk', { kind: res.kind }));
      } catch (err) {
        const raw = err instanceof ApiError ? (err.rawMessage ?? 'ATTRIBUTION_UNKNOWN_ERROR') : 'ATTRIBUTION_UNKNOWN_ERROR';
        setFeedback(`✗ ${raw}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasUserKey, targets, notes, localStatus, t],
  );

  return (
    <Card className="attribution-pool-page">
      <div style={{ padding: 16 }}>
        <Text theme="strong" style={{ fontSize: 18 }}>
          {t('attribution.pool.title')}
        </Text>
        <p style={{ color: '#666', marginTop: 4 }}>{t('attribution.pool.subtitle')}</p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
          <Select
            value={category}
            onChange={(v) => setCategory(String(v))}
            options={[
              { value: '', text: t('attribution.pool.allCategories') },
              ...(view?.categoryOrder ?? []).map((c) => ({ value: c, text: c })),
            ]}
            style={{ minWidth: 260 }}
          />
          <Button onClick={() => void load()}>{t('attribution.refresh')}</Button>
        </div>

        {!hasUserKey && <Alert type="warning">{t('attribution.pool.noUserKey')}</Alert>}
        <div style={{ fontSize: 12, color: '#999', margin: '6px 0' }}>{t('attribution.pool.stateLocalHint')}</div>
        {feedback !== '' && <div style={{ margin: '6px 0' }}>{feedback}</div>}
        {errorCode !== '' && <Alert type="error">{t(`attribution.error.${errorCode}` as never, errorCode)}</Alert>}
        {errorCode === '' && emptyReason === 'no_data' && <Text>{t('attribution.empty.noData')}</Text>}
        {errorCode === '' && emptyReason === 'not_configured' && <Text>{t('attribution.empty.notConfigured')}</Text>}
        {errorCode === '' && emptyReason === 'unreachable' && <Text>{t('attribution.empty.unreachable')}</Text>}

        {view && view.items.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                <th style={{ padding: 6 }}>{t('attribution.pool.categories')}</th>
                <th style={{ padding: 6 }}>{t('attribution.pool.unit')}</th>
                <th style={{ padding: 6 }}>{t('attribution.pool.verdict')}</th>
                <th style={{ padding: 6 }}>{t('attribution.pool.reviewTitle')}</th>
              </tr>
            </thead>
            <tbody>
              {view.items.map((item) => {
                const current = currentOf(item.audit_key);
                const options = allowedTransitions(current);
                return (
                  <tr key={item.audit_key} style={{ borderBottom: '1px solid #f5f5f5' }}>
                    <td style={{ padding: 6 }}>
                      {item.category}
                      {item.categories.length > 1 && (
                        <span style={{ color: '#999', marginLeft: 6 }}>[{item.categories.join(' + ')}]</span>
                      )}
                      {item.rationale_ref && (
                        <span style={{ color: '#b45309', marginLeft: 6 }}>{item.rationale_ref}</span>
                      )}
                    </td>
                    <td style={{ padding: 6, fontFamily: 'monospace' }}>
                      {item.unit_id} <span style={{ color: '#999' }}>r{item.round}</span>
                    </td>
                    <td style={{ padding: 6 }}>{item.verdict ?? '—'}</td>
                    <td style={{ padding: 6 }}>
                      <span style={{ marginRight: 6, color: '#666' }}>
                        {current}
                      </span>
                      <Select
                        value={targets[item.audit_key] ?? ''}
                        onChange={(v) => setTargets((m) => ({ ...m, [item.audit_key]: String(v) }))}
                        options={options.map((s) => ({ value: s, text: s }))}
                        placeholder={t('attribution.pool.target')}
                        style={{ minWidth: 120 }}
                        disabled={!hasUserKey || options.length === 0}
                      />
                      <input
                        value={notes[item.audit_key] ?? ''}
                        maxLength={2000}
                        onChange={(e) => setNotes((m) => ({ ...m, [item.audit_key]: e.target.value }))}
                        placeholder={t('attribution.pool.note')}
                        style={{ marginLeft: 6, width: 160 }}
                        disabled={!hasUserKey}
                      />
                      <Button
                        onClick={() => void submit(item.audit_key)}
                        disabled={!hasUserKey || !targets[item.audit_key]}
                        style={{ marginLeft: 6 }}
                      >
                        {t('attribution.pool.submit')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {view?.truncated && <div style={{ marginTop: 8, color: '#888' }}>{t('attribution.receipt.truncated')}</div>}
      </div>
    </Card>
  );
}
