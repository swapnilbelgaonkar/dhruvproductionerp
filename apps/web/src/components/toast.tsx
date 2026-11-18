import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Toast = { id: number; kind: 'success' | 'error'; text: string };
const Ctx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 5000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed bottom-5 right-5 z-50 flex w-[min(380px,calc(100%-40px))] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className="flex items-start gap-3 rounded-lg bg-white p-4 shadow-hover">
            {t.kind === 'success' ? <CheckCircle size={22} weight="fill" className="text-success-text" aria-hidden /> : <WarningCircle size={22} weight="fill" className="text-danger-text" aria-hidden />}
            <p className="flex-1 text-[14px]">{t.text}</p>
            <button aria-label="Dismiss" onClick={() => setItems((x) => x.filter((y) => y.id !== t.id))} className="text-ink-2 hover:text-ink"><X size={16} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
export const useToast = () => useContext(Ctx);
