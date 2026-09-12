/**
 * AuditPoolPage — 抽查/分歧池页（76 · S7-c）。
 *
 * 数据：BFF `/api/v1/attribution/{pool,review}` → proxy `/v3/admin/attribution/audit-pool|audit-reviews`。
 * 视图模型：`./utils/view-model`（迁移表 / 七类顺序；自迁移禁）。
 *
 * ⚠️ 两个真标注：
 *   1. **actor 服务端注入**：前端**不传** actor（BFF 从 x-tdai-user-key 取）；无 user key
 *      （且非 IdP cookie 会话身份可用）时禁用提交并提示——**不匿名**；
 *   2. 77 · S7-d：**服务端 latest-join 是唯一真相**（池 DTO append `review_status`
 *      /`review_actor`/`review_at`）；本地记录仅作**提交瞬间的乐观反馈**，成功后以服务端
 *      返回值 reconcile 并重取，"刷新后显示 unreviewed"的旧缺口已闭。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Select, Text } from 'tea-component';
import { ApiError } from '@/lib/api/base';
import { attributionApi, type PoolDto } from '@/lib/api/attribution';
import { getPanelSession } from '@/lib/panelSession';
import {
  allowedTransitions,
  currentStatusOf,
  reconcileStatusFromServer,
  toPoolView,
  type PoolItemView,
  type PoolView,
} from './utils/view-model';

/** 从 BFF 400 的信封 `data.current_status` 取"当前状态"（77：原因必须可解释）。 */
function staleCurrentStatus(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const j = JSON.parse(err.body) as { data?: { current_status?: string } };
    return j.data?.current_status ?? null;
  } catch {
    return null;
  }
}

function rawOf(err: unknown): string {
  return err instanceof ApiError
    ? (err.rawMessage ?? 'ATTRIBUTION_UNKNOWN_ERROR')
    : 'ATTRIBUTION_UNKNOWN_ERROR';
}

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
  /** 77 · S7-d：状态筛选走**服务端**（`review_status=`；客户端分页后过滤会漏项）。 */
  const [reviewStatusFilter, setReviewStatusFilter] = useState('');

  const hasUserKey = Boolean(getPanelSession()?.userKey);

  const load = useCallback(async () => {
    setErrorCode('');
    try {
      const query: { category?: string; review_status?: string; limit: number } = { limit: 200 };
      if (category) query.category = category;
      if (reviewStatusFilter) query.review_status = reviewStatusFilter;
      const dto = await attributionApi.pool(query);
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
  }, [category, reviewStatusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const view: PoolView | null = useMemo(() => (pool ? toPoolView(pool) : null), [pool]);
  // 77 · S7-d：当前状态 = **服务端值**（唯一真相）；`localStatus` 仅存提交瞬间的乐观值，
  // 每次 refetch 后服务端值优先。
  const currentOf = (item: PoolItemView): string =>
    localStatus[item.audit_key] ?? currentStatusOf(item);

  const submit = useCallback(
    async (auditKey: string) => {
      const target = targets[auditKey];
      if (!target || !hasUserKey) return;
      // prev = 本端已知的最新（乐观链优先；否则服务端值；都无 ⇒ unreviewed）。
      const itemRow = view?.items.find((i) => i.audit_key === auditKey);
      const prev = localStatus[auditKey] ?? itemRow?.reviewStatus ?? 'unreviewed';
      try {
        const res = await attributionApi.review({
          audit_key: auditKey,
          prev_status: prev,
          status: target,
          note: notes[auditKey]?.trim() || undefined,
        });
        // 乐观仅作即时反馈；立即用**服务端返回值** reconcile（T6），再重取（权威）。
        setLocalStatus((m) => ({ ...m, [auditKey]: reconcileStatusFromServer(res.status) }));
        setFeedback(t('attribution.pool.submitOk', { kind: res.kind }));
        void load();
      } catch (err) {
        // 400 必须能解释原因（C4）：优先显示 data.current_status（"已被更新为 X，请刷新"）。
        const stale = staleCurrentStatus(err);
        setFeedback(stale !== null ? `✗ ${t('attribution.pool.stale', { current: stale })}` : `✗ ${rawOf(err)}`);
        void load(); // 失败同样 reconcile：让用户看到真相
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasUserKey, targets, notes, localStatus, view, t],
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
          {/* 77 · S7-d：状态筛选 = **服务端过滤**（`review_status=`；分页后前端过滤会漏项） */}
          <Select
            value={reviewStatusFilter}
            onChange={(v) => setReviewStatusFilter(String(v))}
            options={[
              { value: '', text: t('attribution.pool.allStatuses') },
              { value: 'unreviewed', text: 'unreviewed' },
              { value: 'confirmed', text: 'confirmed' },
              { value: 'dismissed', text: 'dismissed' },
              { value: 'needs_fix', text: 'needs_fix' },
            ]}
            placeholder={t('attribution.pool.reviewFilter')}
            style={{ minWidth: 160 }}
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
                const current = currentOf(item);
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
