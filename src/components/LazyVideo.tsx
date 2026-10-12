import { useEffect, useRef, useState } from "react";

/** 网格中的视频：进入视口前不加载任何字节（preload=none），可见时才切到 metadata。
 *  一页几十个 <video preload="metadata"> 会在打开页面时同时发起媒体请求。 */
export default function LazyVideo({ src, className, label, controls = true }: { src: string; className?: string; label?: string; controls?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="lazy-video" ref={container}>
      {visible
        ? <video src={src} className={className} controls={controls} preload="metadata" aria-label={label} />
        : <div className="lazy-video-placeholder" role="img" aria-label={label ? `${label}（滚动到此处后加载）` : "视频占位"} />}
    </div>
  );
}
