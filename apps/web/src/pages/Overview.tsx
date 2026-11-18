import { ArrowRight, CheckCircle, ClockCounterClockwise, PencilSimple, PlusCircle, Prohibit, ShieldCheck, SignIn } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, ErrorBanner, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, humanize, initials } from '../lib/format';

interface Overview {
  myPendingApprovals: number; myOverdueApprovals: number;
  myRequests: { open: number; approved: number; rejected: number };
  approvalTrend: { day: string; submitted: number; approved: number }[];
  masters?: { master: string; status: string; n: number }[];
  users?: { active: number; mfa: number; locked: number };
  recentActivity: { seq: number; occurredAt: string; actor: string; action: string; entityType: string }[];
}

const tooltipStyle = { borderRadius: 12, border: 'none', boxShadow: '0 12px 36px rgba(41,38,80,0.12)', fontSize: 13 };

function activityIcon(action: string) {
  if (action.includes('approve') || action.endsWith('.status')) return { Icon: CheckCircle, cls: 'bg-success-bg text-success-text' };
  if (action.includes('reject') || action.includes('deactivat') || action.includes('revoke')) return { Icon: Prohibit, cls: 'bg-danger-bg text-danger-text' };
  if (action.includes('created') || action.includes('submitted') || action.includes('granted')) return { Icon: PlusCircle, cls: 'bg-primary-soft text-primary' };
  if (action.includes('auth')) return { Icon: SignIn, cls: 'bg-info-bg text-info-text' };
  return { Icon: PencilSimple, cls: 'bg-warning-bg text-warning-text' };
}

export function OverviewPage() {
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Overview>('/dashboard/overview') });
  const d = q.data;
  const trend = (d?.approvalTrend ?? []).map((x) => ({ ...x, day: new Date(x.day).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) }));
  const masters = ['Legal entities', 'Plants', 'Warehouses'].map((m) => {
    const rows = d?.masters?.filter((x) => x.master === m) ?? [];
    const get = (s: string[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + Number(r.n), 0);
    return { master: m, Active: get(['Active']), 'In progress': get(['Draft', 'Submitted', 'Rejected']) };
  });
  const decided = (d?.myRequests.approved ?? 0) + (d?.myRequests.rejected ?? 0);
  const donut = d?.users
    ? { title: 'MFA adoption', value: d.users.active ? Math.round((d.users.mfa / d.users.active) * 100) : 0, pill: `${d.users.mfa}/${d.users.active} users`, a: 'With MFA', b: 'Without' }
    : { title: 'My approval rate', value: decided ? Math.round(((d?.myRequests.approved ?? 0) / decided) * 100) : 0, pill: `${decided} decided`, a: 'Approved', b: 'Rejected / returned' };

  return (
    <div className="grid gap-8 2xl:grid-cols-[1fr_360px]">
      <div className="min-w-0">
        <h1 className="mb-8 font-display text-[46px] font-extrabold leading-[1.1] tracking-[-1.5px] md:text-[50px]">Overview</h1>
        <ErrorBanner error={q.error} />
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
          {/* Feature card (UI §12) */}
          <Link to="/approvals" className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#6843FF] to-[#572CF4] p-7 text-white shadow-primary transition duration-300 ease-erp hover:-translate-y-1 xl:col-span-5">
            <div aria-hidden className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" />
            <div className="flex items-center justify-between">
              <span className="flex -space-x-3" aria-hidden><span className="h-9 w-9 rounded-full bg-white/30" /><span className="h-9 w-9 rounded-full bg-white/20" /></span>
              <span className="text-[14px] font-semibold text-white/80">Approvals</span>
            </div>
            {q.isLoading ? <Skeleton className="mt-8 h-12 w-24 opacity-40" /> : <p className="mt-8 font-display text-[44px] font-extrabold leading-none num">{d?.myPendingApprovals ?? 0}</p>}
            <p className="mt-1 text-white/80">waiting for your decision</p>
            <div className="mt-6 flex items-end justify-between text-[13px]">
              <div><p className="uppercase tracking-wide text-white/60">Overdue</p><p className="text-[16px] font-semibold num">{d?.myOverdueApprovals ?? 0}</p></div>
              <div><p className="uppercase tracking-wide text-white/60">My open requests</p><p className="text-[16px] font-semibold num">{d?.myRequests.open ?? 0}</p></div>
              <ArrowRight size={22} className="transition group-hover:translate-x-1" aria-hidden />
            </div>
          </Link>

          <Card title="Approval activity" actions={<span className="text-[13px] text-ink-2">Last 14 days</span>} className="xl:col-span-7">
            {q.isLoading ? <Skeleton className="h-[190px]" /> : (
              <div className="h-[190px]" role="img" aria-label={`Approval requests submitted and approved over the last 14 days. Total submitted ${trend.reduce((a, x) => a + Number(x.submitted), 0)}.`}>
                <ResponsiveContainer>
                  <LineChart data={trend} margin={{ left: -24, right: 8, top: 8 }}>
                    <CartesianGrid vertical={false} stroke="#F1F0F6" strokeDasharray="3 6" />
                    <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6B6B80' }} interval="preserveStartEnd" />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6B6B80' }} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Line type="monotone" dataKey="submitted" name="Submitted" stroke="#5B38F5" strokeWidth={3} dot={false} activeDot={{ r: 6 }} animationDuration={600} />
                    <Line type="monotone" dataKey="approved" name="Approved" stroke="#E639CF" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} animationDuration={600} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {d?.masters && (
            <Card title="Organisation masters" className="xl:col-span-7">
              <div className="h-[230px]" role="img" aria-label={masters.map((m) => `${m.master}: ${m.Active} active, ${m['In progress']} in progress`).join('; ')}>
                <ResponsiveContainer>
                  <BarChart data={masters} barGap={6} margin={{ left: -24, top: 8 }}>
                    <CartesianGrid vertical={false} stroke="#F1F0F6" strokeDasharray="3 6" />
                    <XAxis dataKey="master" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6B6B80' }} />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6B6B80' }} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#F5F2FF' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 13 }} formatter={(v) => <span style={{ color: '#6B6B80' }}>{v}</span>} />
                    <Bar dataKey="Active" fill="#5B38F5" radius={[8, 8, 0, 0]} barSize={10} />
                    <Bar dataKey="In progress" fill="#DED9E8" radius={[8, 8, 0, 0]} barSize={10} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          <Card title={donut.title} className={d?.masters ? 'xl:col-span-5' : 'xl:col-span-12'}>
            <div className="relative mx-auto h-[230px] max-w-[260px]" role="img" aria-label={`${donut.title}: ${donut.value}%`}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={[{ v: donut.value }, { v: 100 - donut.value }]} dataKey="v" innerRadius="78%" outerRadius="90%" startAngle={90} endAngle={-270} cornerRadius={20} stroke="none" animationDuration={700}>
                    <Cell fill="#5B38F5" /><Cell fill="#E9E8F0" />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-display text-[32px] font-extrabold num">{donut.value}%</span>
                <span className="mt-1 rounded-full bg-primary px-2.5 py-0.5 text-[12px] font-semibold text-white">{donut.pill}</span>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Right panel (UI §16–19) */}
      <aside className="card h-fit p-8 2xl:sticky 2xl:top-24">
        <div className="flex items-center gap-4">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-primary-soft font-display text-[22px] font-extrabold text-primary-hover ring-4 ring-primary-tint">
            {initials(me?.user.fullName)}
          </span>
          <Link to="/profile" className="ml-auto grid h-10 w-10 place-items-center rounded-full text-ink-2 hover:bg-primary-tint hover:text-primary" aria-label="Profile and security"><ShieldCheck size={22} /></Link>
        </div>
        <h2 className="mt-5 font-display text-[26px] font-extrabold leading-tight">{me?.user.fullName}</h2>
        <p className="mt-1 text-ink-2">{me?.roles.map((r) => r.name).join(', ') || 'No roles assigned'}</p>

        <div className="mt-6 rounded-xl bg-[#F7F6F9] p-5">
          <p className="text-[13px] text-ink-2">My requests decided</p>
          <div className="mt-2 flex items-end justify-between">
            <p className="font-display text-[30px] font-extrabold num">{decided}</p>
            <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-[12px] font-semibold text-[#9C1C8B]">{d?.myRequests.approved ?? 0} approved</span>
          </div>
        </div>

        <h3 className="mb-3 mt-8 text-[18px] font-semibold">Recent activities</h3>
        {q.isLoading && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>}
        {d && d.recentActivity.length === 0 && <p className="text-ink-2">No activity yet.</p>}
        <ul className="divide-y divide-line">
          {d?.recentActivity.map((a) => {
            const { Icon, cls } = activityIcon(a.action);
            return (
              <li key={a.seq} className="flex items-center gap-3 py-3 transition hover:translate-x-0.5">
                <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg ${cls}`}><Icon size={20} weight="duotone" aria-hidden /></span>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{humanize(a.action.split('.').slice(-2).join(' '))}</span><span className="block truncate text-[13px] text-ink-2">{a.actor}</span></span>
                <time className="shrink-0 text-[12px] text-ink-2">{fmtDateTime(a.occurredAt).split(', ').pop()}</time>
              </li>
            );
          })}
        </ul>
        {me?.permissions.includes('sys.audit:view') && <Link to="/admin/audit" className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-primary hover:text-primary-hover"><ClockCounterClockwise size={16} />Open audit log</Link>}
      </aside>
    </div>
  );
}
