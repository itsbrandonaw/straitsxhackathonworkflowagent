import { useCallback, useEffect, useRef, useState } from "react";

const liveFrameProtocol: typeof import("@happy/contracts").LIVE_FRAME_PROTOCOL = "happy.scout-jpeg.v1";

type Props = {
  apiUrl: string;
  imagery: "snapshots" | "binary_websocket" | "agentcore_live_view";
  scoutId: string;
  stage: string;
  snapshotKey?: string | undefined;
};

const terminalStages = new Set(["selected", "failed", "cancelled"]);

function frameWebSocketUrl(apiUrl: string, scoutId: string): string {
  const url = new URL(`/v1/scouts/${encodeURIComponent(scoutId)}/frames?view=collapsed`, apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function ScoutFrameStream({ apiUrl, imagery, scoutId, stage, snapshotKey }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const firstImage = useRef<HTMLImageElement>(null);
  const secondImage = useRef<HTMLImageElement>(null);
  const images = [firstImage, secondImage] as const;
  const urls = useRef<Array<string | undefined>>([]);
  const active = useRef(-1);
  const receivedLive = useRef(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [feed, setFeed] = useState("Waiting");
  const [inViewport, setInViewport] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  const terminal = terminalStages.has(stage);

  const showFrame = useCallback((blob: Blob) => {
    const next = active.current === 0 ? 1 : 0;
    const previous = active.current;
    const image = images[next].current;
    if (!image) return;
    if (urls.current[next]) URL.revokeObjectURL(urls.current[next]!);
    const url = URL.createObjectURL(blob);
    urls.current[next] = url;
    image.onload = () => {
      image.classList.add("active");
      if (previous >= 0) {
        const previousImage = previous === 0 ? firstImage : secondImage;
        previousImage.current?.classList.remove("active");
        const oldUrl = urls.current[previous];
        window.setTimeout(() => {
          if (urls.current[previous] === oldUrl && oldUrl) {
            URL.revokeObjectURL(oldUrl);
            urls.current[previous] = undefined;
          }
        }, 250);
      }
      active.current = next;
      setHasFrame(true);
    };
    image.src = url;
  }, []);

  useEffect(() => {
    const node = container.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setInViewport(entry?.isIntersecting ?? true), {
      rootMargin: "100px"
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => () => {
    for (const url of urls.current) if (url) URL.revokeObjectURL(url);
  }, []);

  useEffect(() => {
    if (!snapshotKey || receivedLive.current) return;
    const controller = new AbortController();
    void fetch(`${apiUrl}/v1/scouts/${encodeURIComponent(scoutId)}/snapshot?v=${encodeURIComponent(snapshotKey)}`, {
      signal: controller.signal
    }).then((response) => {
      if (!response.ok) throw new Error("snapshot unavailable");
      return response.blob();
    }).then(showFrame).catch(() => undefined);
    if (imagery !== "binary_websocket") setFeed("Snapshot");
    return () => controller.abort();
  }, [apiUrl, imagery, scoutId, showFrame, snapshotKey]);

  useEffect(() => {
    if (imagery !== "binary_websocket" || terminal || !inViewport || !pageVisible) {
      if (terminal) setFeed("Last frame");
      else if (!pageVisible || !inViewport) setFeed("Paused");
      return;
    }
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let reconnectDelay = 500;

    const connect = () => {
      if (disposed) return;
      setFeed("Connecting");
      socket = new WebSocket(frameWebSocketUrl(apiUrl, scoutId), liveFrameProtocol);
      socket.binaryType = "blob";
      socket.onopen = () => { reconnectDelay = 500; };
      socket.onmessage = (message) => {
        if (typeof message.data === "string") {
          try {
            const status = JSON.parse(message.data) as { type?: string; framesPerSecond?: number };
            if (status.type === "ready" || status.type === "rate_changed") {
              setFeed(`Live ${(status.framesPerSecond ?? 0).toFixed(1)} FPS`);
            } else if (status.type === "completed") {
              setFeed("Last frame");
            }
          } catch {
            // Ignore unknown status messages; binary frames remain usable.
          }
          return;
        }
        receivedLive.current = true;
        showFrame(message.data instanceof Blob ? message.data : new Blob([message.data], { type: "image/jpeg" }));
      };
      socket.onclose = () => {
        socket = undefined;
        if (disposed) return;
        setFeed("Reconnecting");
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(5_000, reconnectDelay * 2);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [apiUrl, imagery, inViewport, pageVisible, scoutId, showFrame, terminal]);

  return <div className="frameStream" ref={container}>
    <img ref={images[0]} alt={`${scoutId} browser frame`} />
    <img ref={images[1]} alt={`${scoutId} browser frame`} />
    {!hasFrame && <div className="placeholder">Queued for a browser frame</div>}
    <span className="frameStatus">{feed}</span>
  </div>;
}
