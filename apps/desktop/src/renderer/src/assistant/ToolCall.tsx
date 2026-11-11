import { IconCheck, IconLoader2, IconShieldX, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

import { useStudio } from '../state/store';
import { card } from './Fold';
import type { ConversationItem } from './store';

export type ToolItem = Extract<ConversationItem, { kind: 'tool' }>;

/**
 * One tool call with its decision and result (chat polish: a quiet line, no box of its own),
 * inside a step or a group of queries; `framed` when it stands alone in the chat (a refused call).
 */
export function ToolCall({ item, framed = false }: { item: ToolItem; framed?: boolean }) {
  const { t } = useTranslation();
  const debug = useStudio((state) => state.toolDebug);
  const icon =
    item.decision === 'denied' ? (
      <IconShieldX className="size-icon-sm shrink-0 text-warning" aria-hidden />
    ) : item.ok === undefined ? (
      <IconLoader2 className="size-icon-sm shrink-0 animate-spin text-accent" aria-hidden />
    ) : item.ok ? (
      <IconCheck className="size-icon-sm shrink-0 text-success" aria-hidden />
    ) : (
      <IconX className="size-icon-sm shrink-0 text-danger" aria-hidden />
    );
  const state =
    item.decision === 'denied'
      ? t('assistant.tool.denied')
      : item.ok === undefined
        ? t('assistant.tool.running')
        : item.ok
          ? t('assistant.tool.done')
          : t('assistant.tool.failed');
  return (
    <div className={`flex min-w-0 flex-col text-sm ${framed ? `${card} border-border px-3 py-2` : 'py-hairline'}`} data-testid="tool-call">
      <span className="flex min-w-0 items-center gap-2 text-text">
        {icon}
        <span className="truncate font-medium">{item.name}</span>
        <span className="shrink-0 text-xs text-text-subtle">{state}</span>
      </span>
      {item.decision === 'denied' && item.reason ? <span className="pl-5 text-text-muted">{item.reason}</span> : null}
      {debug && item.decision === 'allowed' && item.ok === false && item.reason ? (
        <details className="pl-5 text-xs text-text-muted">
          <summary className="cursor-pointer">{t('assistant.tool.errorDetails')}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{item.reason}</p>
        </details>
      ) : null}
      {item.summary && /^[[{]/.test(item.summary.trim()) ? (
        // Raw call data only on request, wrapped instead of cut (audit C-03).
        <details className="pl-5 text-xs text-text-subtle">
          <summary className="cursor-default">{t('assistant.tool.details')}</summary>
          <p className="break-all whitespace-pre-wrap">{item.summary}</p>
        </details>
      ) : item.summary ? (
        <span className="pl-5 text-xs break-words text-text-subtle">{item.summary}</span>
      ) : null}
    </div>
  );
}
