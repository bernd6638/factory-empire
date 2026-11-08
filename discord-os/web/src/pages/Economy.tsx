import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Briefcase, Building2, Coins, Landmark, Pencil, Plus, Receipt, Settings2, ShoppingBag, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../lib/api';
import { compact, num, relative, shortDay } from '../lib/format';
import type { Paged } from '../lib/types';
import { useCan, useGuildId, useLookup, useModuleConfig } from '../hooks/guild';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, Field, Input, LoadingBlock, NumberInput, PageHeader, Pagination, StatCard, Switch, Tabs } from '../components/ui/core';
import { Modal, useConfirm, useToast } from '../components/ui/overlay';
import { RoleSelect } from '../components/ui/pickers';
import { ModuleToggle, SaveBar } from '../components/ui/module';
import { CHART, ChartTooltip, GradientDefs, axisProps } from '../components/ui/chart';

interface ShopItem { id: number; name: string; description: string | null; emoji: string | null; price: number; stock: number | null; roleId: string | null; tradable: boolean; enabled: boolean; _count?: { inventory: number } }
interface Job { id: number; name: string; description: string | null; emoji: string | null; minPay: number; maxPay: number; requiredLevel: number; _count?: { accounts: number } }
interface Account { userId: string; username: string; avatarUrl: string; wallet: number; bank: number; total: number; totalEarned: number; rank: number }
interface Tx { id: number; type: string; fromUserId: string | null; toUserId: string | null; amount: number; note: string | null; createdAt: string }

const TX_LABEL: Record<string, string> = { DAILY: 'Täglich', WORK: 'Arbeit', MESSAGE: 'Nachricht', TRANSFER: 'Überweisung', PURCHASE: 'Kauf', TRADE: 'Handel', DEPOSIT: 'Einzahlung', WITHDRAW: 'Abhebung', COMPANY: 'Firma', ADMIN: 'Admin', REWARD: 'Belohnung' };

function Overview() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = useCan('ADMIN');
  const [page, setPage] = useState(1);
  const [txPage, setTxPage] = useState(1);
  const [adjust, setAdjust] = useState<Account | null>(null);
  const [delta, setDelta] = useState(0);
  const { data: ov } = useQuery({ queryKey: ['economy', 'overview', guildId], queryFn: () => api.get<{ config: { currencySymbol: string; currencyName: string }; totalWallet: number; totalBank: number; accounts: number; transactions30d: number; series: { date: string; volume: number; count: number }[] }>(`/guilds/${guildId}/economy/overview`) });
  const { data: accounts } = useQuery({ queryKey: ['economy', 'accounts', guildId, page], queryFn: () => api.get<Paged<Account>>(`/guilds/${guildId}/economy/accounts${qs({ page, limit: 15 })}`), placeholderData: (p) => p });
  const { data: txs } = useQuery({ queryKey: ['economy', 'tx', guildId, txPage], queryFn: () => api.get<Paged<Tx>>(`/guilds/${guildId}/economy/transactions${qs({ page: txPage, limit: 15 })}`), placeholderData: (p) => p });
  const save = useMutation({
    mutationFn: () => api.patch(`/guilds/${guildId}/economy/accounts/${adjust!.userId}`, { walletDelta: delta }),
    onSuccess: () => {
      toast.success('Kontostand angepasst');
      setAdjust(null);
      void qc.invalidateQueries({ queryKey: ['economy'] });
    },
    onError: toast.error,
  });
  const sym = ov?.config.currencySymbol ?? '';
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Im Umlauf (Wallet)" value={`${sym} ${compact(ov?.totalWallet)}`} icon={Wallet} accent="yellow" />
        <StatCard label="Auf Banken" value={`${sym} ${compact(ov?.totalBank)}`} icon={Landmark} accent="blue" />
        <StatCard label="Konten" value={num(ov?.accounts)} icon={Coins} />
        <StatCard label="Transaktionen (30 T)" value={num(ov?.transactions30d)} icon={Receipt} accent="violet" />
      </div>
      <Card>
        <CardHeader title="Transaktionsvolumen" icon={ArrowLeftRight} />
        <div className="h-56 p-4">
          <ResponsiveContainer>
            <AreaChart data={ov?.series ?? []}>
              <GradientDefs id="gEco" color={CHART.yellow} />
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDay} {...axisProps} minTickGap={20} />
              <YAxis {...axisProps} width={50} tickFormatter={(v) => compact(v)} />
              <Tooltip content={<ChartTooltip labelFormatter={shortDay} />} />
              <Area dataKey="volume" name="Volumen" stroke={CHART.yellow} fill="url(#gEco)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Rangliste" description="Nach Gesamtvermögen" icon={Coins} />
          {!accounts?.items.length ? <EmptyState icon={Wallet} title="Noch keine Konten" /> : (
            <>
              <div className="divide-y divide-line/60">
                {accounts.items.map((a) => (
                  <div key={a.userId} className="flex items-center gap-3 px-5 py-2.5">
                    <span className="w-8 text-sm font-semibold text-fg-subtle">#{a.rank}</span>
                    <Avatar src={a.avatarUrl} name={a.username} size={30} />
                    <span className="flex-1 truncate text-sm font-medium">{a.username}</span>
                    <span className="text-xs text-fg-muted tabular-nums">{sym} {num(a.wallet)} + {num(a.bank)}</span>
                    <span className="w-24 text-right font-semibold tabular-nums">{num(a.total)}</span>
                    {isAdmin && <Button size="icon" variant="ghost" icon={Pencil} onClick={() => (setDelta(0), setAdjust(a))} />}
                  </div>
                ))}
              </div>
              <Pagination page={accounts.page} total={accounts.total} limit={accounts.limit} onChange={setPage} />
            </>
          )}
        </Card>
        <Card>
          <CardHeader title="Transaktionshistorie" icon={Receipt} />
          {!txs?.items.length ? <EmptyState icon={Receipt} title="Keine Transaktionen" /> : (
            <>
              <div className="divide-y divide-line/60">
                {txs.items.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <Badge color={t.type === 'PURCHASE' ? 'yellow' : t.type === 'ADMIN' ? 'red' : 'gray'}>{TX_LABEL[t.type] ?? t.type}</Badge>
                    <span className="flex-1 truncate text-fg-muted">{t.note ?? `${t.fromUserId ?? '—'} → ${t.toUserId ?? '—'}`}</span>
                    <span className="font-medium tabular-nums">{num(t.amount)}</span>
                    <span className="w-20 text-right text-xs text-fg-subtle">{relative(t.createdAt)}</span>
                  </div>
                ))}
              </div>
              <Pagination page={txs.page} total={txs.total} limit={txs.limit} onChange={setTxPage} />
            </>
          )}
        </Card>
      </div>
      <Modal open={!!adjust} onClose={() => setAdjust(null)} size="sm" title={`Konto anpassen: ${adjust?.username}`} footer={<Button variant="primary" loading={save.isPending} disabled={delta === 0} onClick={() => save.mutate()}>Anwenden</Button>}>
        <Field label="Betrag (Wallet)" hint="Positiv = gutschreiben, negativ = abziehen. Wird als Admin-Transaktion protokolliert.">
          <NumberInput value={delta} min={-100000000} max={100000000} onChange={setDelta} />
        </Field>
      </Modal>
    </div>
  );
}

function ShopTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = useCan('ADMIN');
  const { roleName } = useLookup();
  const [edit, setEdit] = useState<Partial<ShopItem> | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['economy', 'shop', guildId], queryFn: () => api.get<ShopItem[]>(`/guilds/${guildId}/economy/shop`) });
  const save = useMutation({
    mutationFn: (item: Partial<ShopItem>) => {
      const body = { name: item.name, description: item.description || null, emoji: item.emoji || null, price: item.price ?? 0, stock: item.stock ?? null, roleId: item.roleId ?? null, tradable: item.tradable ?? true, enabled: item.enabled ?? true };
      return item.id ? api.patch(`/guilds/${guildId}/economy/shop/${item.id}`, body) : api.post(`/guilds/${guildId}/economy/shop`, body);
    },
    onSuccess: () => {
      toast.success('Artikel gespeichert');
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ['economy', 'shop'] });
    },
    onError: toast.error,
  });
  const del = useMutation({ mutationFn: (id: number) => api.del(`/guilds/${guildId}/economy/shop/${id}`), onSuccess: () => (toast.success('Artikel gelöscht'), void qc.invalidateQueries({ queryKey: ['economy', 'shop'] })), onError: toast.error });
  return (
    <Card>
      <CardHeader title="Virtueller Shop" description="Mitglieder kaufen mit /buy – Rollen-Artikel vergeben die Rolle automatisch." icon={ShoppingBag} actions={isAdmin && <Button variant="primary" icon={Plus} onClick={() => setEdit({ price: 100, tradable: true, enabled: true, stock: null })}>Artikel</Button>} />
      {isLoading ? <LoadingBlock /> : !data?.length ? <EmptyState icon={ShoppingBag} title="Der Shop ist leer" /> : (
        <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
          {data.map((it) => (
            <div key={it.id} className={`rounded-xl border border-line bg-panel-2/50 p-4 ${!it.enabled ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-panel-3 text-xl">{it.emoji || '📦'}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{it.name}</div>
                  <div className="text-sm text-amber-300">{num(it.price)}</div>
                </div>
                {isAdmin && (
                  <div className="flex">
                    <Button size="icon" variant="ghost" icon={Pencil} onClick={() => setEdit(it)} />
                    <Button size="icon" variant="ghost" icon={Trash2} onClick={async () => (await confirm({ title: `„${it.name}“ löschen?`, message: 'Der Artikel wird auch aus allen Inventaren entfernt.', danger: true })) && del.mutate(it.id)} />
                  </div>
                )}
              </div>
              {it.description && <p className="mt-2 text-sm text-fg-muted">{it.description}</p>}
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge>{it.stock === null ? 'Unbegrenzt' : `Bestand: ${it.stock}`}</Badge>
                {it.roleId && <Badge color="violet">Rolle: {roleName(it.roleId)}</Badge>}
                {!it.tradable && <Badge color="yellow">Nicht handelbar</Badge>}
                <Badge color="blue">{it._count?.inventory ?? 0} Besitzer</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Artikel bearbeiten' : 'Neuer Artikel'} footer={<Button variant="primary" loading={save.isPending} disabled={!edit?.name} onClick={() => edit && save.mutate(edit)}>Speichern</Button>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-[80px_1fr]">
            <Field label="Emoji"><Input value={edit.emoji ?? ''} onChange={(e) => setEdit({ ...edit, emoji: e.target.value })} maxLength={64} /></Field>
            <Field label="Name"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={64} /></Field>
            <Field label="Beschreibung" className="sm:col-span-2"><Input value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} maxLength={200} /></Field>
            <Field label="Preis" className="sm:col-span-2"><NumberInput value={edit.price ?? 0} min={0} max={100000000} onChange={(v) => setEdit({ ...edit, price: v })} /></Field>
            <Field label="Bestand" hint="Leer lassen = unbegrenzt" className="sm:col-span-2"><Input type="number" min={0} value={edit.stock ?? ''} onChange={(e) => setEdit({ ...edit, stock: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
            <Field label="Rolle beim Kauf" className="sm:col-span-2"><RoleSelect assignable value={edit.roleId ?? null} onChange={(v) => setEdit({ ...edit, roleId: v })} placeholder="Keine Rolle" /></Field>
            <div className="space-y-2 sm:col-span-2">
              <Switch label="Handelbar" checked={edit.tradable ?? true} onChange={(v) => setEdit({ ...edit, tradable: v })} />
              <Switch label="Im Shop sichtbar" checked={edit.enabled ?? true} onChange={(v) => setEdit({ ...edit, enabled: v })} />
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function JobsTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = useCan('ADMIN');
  const [edit, setEdit] = useState<Partial<Job> | null>(null);
  const { data: jobs, isLoading } = useQuery({ queryKey: ['economy', 'jobs', guildId], queryFn: () => api.get<Job[]>(`/guilds/${guildId}/economy/jobs`) });
  const { data: companies } = useQuery({ queryKey: ['economy', 'companies', guildId], queryFn: () => api.get<{ id: number; name: string; ownerId: string; balance: number; open: boolean; members: { userId: string }[] }[]>(`/guilds/${guildId}/economy/companies`) });
  const save = useMutation({
    mutationFn: (j: Partial<Job>) => {
      const body = { name: j.name, description: j.description || null, emoji: j.emoji || null, minPay: j.minPay ?? 0, maxPay: j.maxPay ?? 0, requiredLevel: j.requiredLevel ?? 0 };
      return j.id ? api.patch(`/guilds/${guildId}/economy/jobs/${j.id}`, body) : api.post(`/guilds/${guildId}/economy/jobs`, body);
    },
    onSuccess: () => (toast.success('Job gespeichert'), setEdit(null), void qc.invalidateQueries({ queryKey: ['economy', 'jobs'] })),
    onError: toast.error,
  });
  const del = useMutation({ mutationFn: (id: number) => api.del(`/guilds/${guildId}/economy/jobs/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['economy', 'jobs'] }), onError: toast.error });
  const delCompany = useMutation({ mutationFn: (id: number) => api.del(`/guilds/${guildId}/economy/companies/${id}`), onSuccess: () => (toast.success('Firma aufgelöst'), void qc.invalidateQueries({ queryKey: ['economy', 'companies'] })), onError: toast.error });
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Jobs" description="Mitglieder nehmen Jobs mit /job join an und verdienen mit /work." icon={Briefcase} actions={isAdmin && <Button variant="primary" icon={Plus} onClick={() => setEdit({ minPay: 50, maxPay: 150, requiredLevel: 0 })}>Job</Button>} />
        {isLoading ? <LoadingBlock /> : !jobs?.length ? <EmptyState icon={Briefcase} title="Keine Jobs" description="Ohne Job erhalten Mitglieder den Standardlohn aus den Einstellungen." /> : (
          <div className="divide-y divide-line/60">
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center gap-3 px-5 py-3">
                <span className="text-xl">{j.emoji || '💼'}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{j.name}</div>
                  <div className="text-xs text-fg-subtle">{num(j.minPay)}–{num(j.maxPay)} pro Schicht · ab Level {j.requiredLevel} · {j._count?.accounts ?? 0} Angestellte</div>
                </div>
                {isAdmin && <><Button size="icon" variant="ghost" icon={Pencil} onClick={() => setEdit(j)} /><Button size="icon" variant="ghost" icon={Trash2} onClick={async () => (await confirm({ title: `Job „${j.name}“ löschen?`, danger: true })) && del.mutate(j.id)} /></>}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Firmen" description="Gegründet mit /company create" icon={Building2} />
        {!companies?.length ? <EmptyState icon={Building2} title="Keine Firmen" /> : (
          <div className="divide-y divide-line/60">
            {companies.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-5 py-3">
                <Building2 className="h-5 w-5 text-fg-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-fg-subtle">Inhaber {c.ownerId} · {c.members.length} Mitglieder · {c.open ? 'offen' : 'geschlossen'}</div>
                </div>
                <span className="font-semibold tabular-nums text-amber-300">{num(c.balance)}</span>
                {isAdmin && <Button size="icon" variant="ghost" icon={Trash2} onClick={async () => (await confirm({ title: `Firma „${c.name}“ auflösen?`, message: 'Das Firmenguthaben geht verloren.', danger: true })) && delCompany.mutate(c.id)} />}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Job bearbeiten' : 'Neuer Job'} footer={<Button variant="primary" loading={save.isPending} disabled={!edit?.name} onClick={() => edit && save.mutate(edit)}>Speichern</Button>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-[80px_1fr]">
            <Field label="Emoji"><Input value={edit.emoji ?? ''} onChange={(e) => setEdit({ ...edit, emoji: e.target.value })} /></Field>
            <Field label="Name"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={64} /></Field>
            <Field label="Beschreibung" className="sm:col-span-2"><Input value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} maxLength={200} /></Field>
            <Field label="Mindestlohn"><NumberInput value={edit.minPay ?? 0} min={0} max={10000000} onChange={(v) => setEdit({ ...edit, minPay: v })} /></Field>
            <Field label="Höchstlohn"><NumberInput value={edit.maxPay ?? 0} min={0} max={10000000} onChange={(v) => setEdit({ ...edit, maxPay: v })} /></Field>
            <Field label="Benötigtes Level" className="sm:col-span-2"><NumberInput value={edit.requiredLevel ?? 0} min={0} max={1000} onChange={(v) => setEdit({ ...edit, requiredLevel: v })} /></Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

function SettingsTab() {
  const m = useModuleConfig('economy');
  if (m.isLoading || !m.config) return <LoadingBlock />;
  const c = m.config;
  return (
    <div className="space-y-4">
      <ModuleToggle name="Economy" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <p className="text-xs text-fg-subtle">Die Economy ist ein rein virtuelles Spielsystem ohne echtes Geld.</p>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Währung" icon={Coins} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Name"><Input value={c.currencyName} maxLength={32} onChange={(e) => m.update((d) => void (d.currencyName = e.target.value))} /></Field>
            <Field label="Symbol"><Input value={c.currencySymbol} maxLength={16} onChange={(e) => m.update((d) => void (d.currencySymbol = e.target.value))} /></Field>
            <Field label="Startguthaben"><NumberInput value={c.startingBalance} min={0} max={1000000} onChange={(v) => m.update((d) => void (d.startingBalance = v))} /></Field>
            <Field label="Überweisungssteuer"><NumberInput value={c.transferTaxPercent} min={0} max={50} suffix="%" onChange={(v) => m.update((d) => void (d.transferTaxPercent = v))} /></Field>
          </div>
        </Card>
        <Card>
          <CardHeader title="Einkommen" icon={Wallet} />
          <div className="grid gap-4 p-5 sm:grid-cols-3">
            <Field label="Tagesbonus"><NumberInput value={c.daily.amount} min={0} max={1000000} onChange={(v) => m.update((d) => void (d.daily.amount = v))} /></Field>
            <Field label="Streak-Bonus/Tag"><NumberInput value={c.daily.streakBonus} min={0} max={100000} onChange={(v) => m.update((d) => void (d.daily.streakBonus = v))} /></Field>
            <Field label="Max. Streak"><NumberInput value={c.daily.maxStreak} min={1} max={365} suffix="Tage" onChange={(v) => m.update((d) => void (d.daily.maxStreak = v))} /></Field>
            <Field label="Arbeitslohn min."><NumberInput value={c.work.min} min={0} max={1000000} onChange={(v) => m.update((d) => void (d.work.min = v))} /></Field>
            <Field label="Arbeitslohn max."><NumberInput value={c.work.max} min={0} max={1000000} onChange={(v) => m.update((d) => void (d.work.max = v))} /></Field>
            <Field label="Arbeits-Cooldown"><NumberInput value={c.work.cooldownMinutes} min={1} max={1440} suffix="Min." onChange={(v) => m.update((d) => void (d.work.cooldownMinutes = v))} /></Field>
            <div className="sm:col-span-3"><Switch label="Coins für Nachrichten" checked={c.messageReward.enabled} onChange={(v) => m.update((d) => void (d.messageReward.enabled = v))} /></div>
            {c.messageReward.enabled && (
              <>
                <Field label="Min."><NumberInput value={c.messageReward.min} min={0} max={10000} onChange={(v) => m.update((d) => void (d.messageReward.min = v))} /></Field>
                <Field label="Max."><NumberInput value={c.messageReward.max} min={0} max={10000} onChange={(v) => m.update((d) => void (d.messageReward.max = v))} /></Field>
                <Field label="Cooldown"><NumberInput value={c.messageReward.cooldownSeconds} min={0} max={3600} suffix="Sek." onChange={(v) => m.update((d) => void (d.messageReward.cooldownSeconds = v))} /></Field>
              </>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Firmen" icon={Building2} />
          <div className="grid gap-4 p-5 sm:grid-cols-3">
            <Field label="Gründungskosten"><NumberInput value={c.companyCreateCost} min={0} max={10000000} onChange={(v) => m.update((d) => void (d.companyCreateCost = v))} /></Field>
            <Field label="Firmenbonus bei /work"><NumberInput value={c.companyBonusPercent} min={0} max={100} suffix="%" onChange={(v) => m.update((d) => void (d.companyBonusPercent = v))} /></Field>
            <Field label="Max. Mitglieder"><NumberInput value={c.maxCompanyMembers} min={1} max={100} onChange={(v) => m.update((d) => void (d.maxCompanyMembers = v))} /></Field>
          </div>
        </Card>
      </div>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

export default function EconomyPage() {
  const [tab, setTab] = useState<'overview' | 'shop' | 'jobs' | 'settings'>('overview');
  return (
    <>
      <PageHeader title="Economy" description="Virtuelle Währung, Shop, Jobs, Firmen und Transaktionen" icon={Coins} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Übersicht', icon: Wallet }, { id: 'shop', label: 'Shop', icon: ShoppingBag }, { id: 'jobs', label: 'Jobs & Firmen', icon: Briefcase }, { id: 'settings', label: 'Einstellungen', icon: Settings2 }]} />
      {tab === 'overview' && <Overview />}
      {tab === 'shop' && <ShopTab />}
      {tab === 'jobs' && <JobsTab />}
      {tab === 'settings' && <SettingsTab />}
    </>
  );
}
