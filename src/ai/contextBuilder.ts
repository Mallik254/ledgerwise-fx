import type { ContextSlices, LedgerSnapshot } from './types';

export function buildLedgerContextString(
  snap: LedgerSnapshot | null,
  slices: ContextSlices
): string {
  if (!snap) return 'Workspace state is not initialized yet.';

  const lines: string[] = [
    `Trader: ${snap.traderName || 'Trader'} | Trading currency: ${snap.currency} | Household base currency: ${snap.homeCurrency} | Active view: ${snap.currentPage}`,
    `Financial Health Score: ${snap.healthScore}/100 (${snap.healthLabel}) | Total Account Equity: ${snap.totalEquityFormatted}`,
  ];

  if (slices.accounts) {
    if (snap.accounts.length > 0) {
      lines.push('ACTIVE ACCOUNTS & PROP BUFFERS:');
      for (const acc of snap.accounts) {
        lines.push(
          `- ${acc.name} (${acc.firm || acc.kind}, ${acc.currency}): Equity ${acc.equityFormatted}, P&L ${acc.profitFormatted}, Daily Loss Room ${acc.dailyRemainingFormatted} (${acc.dailyUsedPct.toFixed(0)}% used), Max DD Buffer ${acc.bufferFormatted} (${acc.bufferPct.toFixed(0)}% left), Base/Ladder Risk ${acc.effectiveRiskPct.toFixed(2)}%, Status: ${acc.level}, Payout eligible: ${acc.payoutEligible ? 'Yes' : 'No'}, Health ${acc.healthScore}/100`
        );
      }
    } else {
      lines.push('ACTIVE ACCOUNTS: None logged yet.');
    }
  }

  if (slices.trades) {
    lines.push(
      `LIVE TRADE SUMMARY: ${snap.tradeCount} live trades (${snap.backtestCount} backtest setups) | Win Rate: ${snap.winRatePct != null ? `${snap.winRatePct.toFixed(1)}%` : 'N/A'} | Expectancy: ${snap.expectancyFormatted} | Profit Factor: ${snap.profitFactorLabel}`
    );
    if (snap.recentTrades.length > 0) {
      lines.push('RECENT TRADES:');
      for (const t of snap.recentTrades.slice(0, 8)) {
        const rStr = t.r != null ? `${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R` : 'no R';
        const pipStr = t.pips != null ? `${t.pips.toFixed(1)}p` : '—';
        const chk = t.checkTotal ? `, checklist ${t.checkScore ?? 0}/${t.checkTotal}` : '';
        lines.push(
          `- ${t.date} ${t.pair} ${t.direction.toUpperCase()} (${t.session}, setup: ${t.setup || 'untagged'}, grade: ${t.grade || '—'}${chk}): ${rStr}, ${pipStr}, Net ${t.netFormatted}`
        );
      }
    }
    if (snap.openWatches.length > 0) {
      lines.push(`ARMED SETUP WATCHES (${snap.openWatchCount} open):`);
      for (const w of snap.openWatches.slice(0, 4)) {
        lines.push(`- ${w.pair} (${w.windowLabel}) Bias: ${w.bias || '—'} | Trigger: ${w.trigger || '—'}`);
      }
    }
  }

  if (slices.cashflow) {
    lines.push(
      `MONTHLY CASHFLOW & RUNWAY: Expected Payouts ${snap.expectedPayoutFormatted} | Month Income ${snap.monthIncomeFormatted} | Tax Reserve ${snap.monthTaxFormatted} | Spendable ${snap.monthSpendableFormatted} | Month Expenses ${snap.monthExpensesFormatted} | Household Runway: ${snap.runwayMonths != null ? `${snap.runwayMonths.toFixed(1)} months` : 'N/A'}`
    );
    if (snap.goalsSummary.length > 0) {
      lines.push('TOP GOALS:');
      for (const g of snap.goalsSummary.slice(0, 4)) {
        lines.push(`- ${g.title}: ${g.progressPct.toFixed(0)}% of ${g.targetFormatted}`);
      }
    }
  }

  if (slices.psychology) {
    lines.push(
      `GOVERNANCE & PSYCHOLOGY: Charter adopted: ${snap.charterAdopted ? 'Yes' : 'Not yet'} | Open charter breaches: ${snap.openBreaches} | Fear Cards logged: ${snap.fearCardCount}`
    );
    if (snap.recentFear.length > 0) {
      lines.push('RECENT FEAR EVENTS:');
      for (const f of snap.recentFear.slice(0, 4)) {
        lines.push(`- ${f.date} [${f.emotion}] Trigger: ${f.trigger} | Cost: ${f.cost}`);
      }
    }
  }

  return lines.join('\n');
}

export interface DynamicPromptChip {
  label: string;
  prompt: string;
  useSearch?: boolean;
  persona?: 'coach' | 'risk' | 'cfo' | 'macro';
}

export function buildQuickPrompts(snap: LedgerSnapshot | null): DynamicPromptChip[] {
  const chips: DynamicPromptChip[] = [];

  if (snap && snap.accounts.length > 0) {
    const topAcc = snap.accounts[0];
    chips.push({
      label: `Audit ${topAcc.name} DD buffer`,
      prompt: `Audit my ${topAcc.name} account (${topAcc.equityFormatted} equity, ${topAcc.dailyRemainingFormatted} daily room, ${topAcc.bufferFormatted} max DD buffer, ${topAcc.effectiveRiskPct.toFixed(2)}% risk). Am I sized safely for the next session?`,
      persona: 'risk',
    });
  }

  if (snap && snap.recentTrades.length > 0) {
    chips.push({
      label: `Review last ${Math.min(5, snap.recentTrades.length)} trades`,
      prompt: `Analyze my last ${Math.min(5, snap.recentTrades.length)} trades for setup quality, checklist adherence, R-expectancy leaks, and the #1 fix before my next trade.`,
      persona: 'coach',
    });
  }

  if (snap && (snap.openWatches.length > 0 || snap.recentTrades.length > 0)) {
    const activePair = snap.openWatches[0]?.pair || snap.recentTrades[0]?.pair || 'EURUSD & XAUUSD';
    chips.push({
      label: `Live macro & catalysts for ${activePair}`,
      prompt: `Search today's live macro drivers, central bank commentary, and upcoming high-impact economic releases affecting ${activePair}. What session risks should I watch?`,
      useSearch: true,
      persona: 'macro',
    });
  } else {
    chips.push({
      label: 'Today’s FX macro & news catalysts',
      prompt: `Search today's key FX macro drivers, USD/EUR/GBP/JPY central bank bias, and high-impact economic calendar events for this week.`,
      useSearch: true,
      persona: 'macro',
    });
  }

  chips.push({
    label: 'Payout waterfall & runway check',
    prompt: `Review my monthly cashflow (${snap?.monthSpendableFormatted || 'current spendable'} spendable vs ${snap?.monthExpensesFormatted || 'current expenses'} expenses, runway ${snap?.runwayMonths != null ? `${snap.runwayMonths.toFixed(1)} months` : 'not set'}). How should I split my next payout across tax, buffer, and goals?`,
    persona: 'cfo',
  });

  return chips.slice(0, 4);
}
