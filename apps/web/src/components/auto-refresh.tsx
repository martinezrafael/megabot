'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/** Recarrega os dados da página (sem piscar) a cada N segundos e permite pausar. */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  const [on, setOn] = useState(true);

  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [on, seconds, router]);

  return (
    <span className="refresh-controls">
      <button type="button" className="link-button" onClick={() => router.refresh()}>
        Atualizar agora
      </button>
      <label>
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Atualizar a
        cada {seconds} s
      </label>
    </span>
  );
}
