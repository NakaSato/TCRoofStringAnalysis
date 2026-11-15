/**
 * A `PanelChart` that fills the height its flex parent gives it (at least `minHeight`), so a card
 * stretched to its grid row has no empty band under its content. The legend's own height is
 * measured and taken off the plot, whatever it wraps to.
 */
import React, { useLayoutEffect, useRef, useState } from "react";
import { PanelChart } from "../../components/PanelChart";

type Props = Omit<React.ComponentProps<typeof PanelChart>, "height"> & { minHeight?: number };

export const FillChart: React.FC<Props> = ({ minHeight = 240, ...props }) => {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(minHeight);
  const hRef = useRef(h);
  hRef.current = h;

  useLayoutEffect(() => {
    const b = box.current;
    const i = inner.current;
    if (!b || !i) return;
    const fit = () => {
      // everything besides the plot (legend, above or below) = rendered height − the plot height we asked for
      const extra = Math.max(0, i.scrollHeight - hRef.current);
      const next = Math.max(minHeight, Math.floor(b.clientHeight - extra));
      if (Math.abs(next - hRef.current) > 1) setH(next);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    ro.observe(i);
    return () => ro.disconnect();
  }, [minHeight]);

  // the box takes the free height; the chart sits on top of it, so it never pushes the card taller
  return (
    <div ref={box} className="relative min-w-0 flex-1" style={{ minHeight: minHeight + 28 }}>
      <div ref={inner} className="absolute inset-x-0 top-0">
        <PanelChart {...props} height={h} />
      </div>
    </div>
  );
};
