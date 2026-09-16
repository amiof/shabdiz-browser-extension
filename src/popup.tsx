import { useEffect, useState } from "react"
import { SHABDIZ_ENABLED_KEY, isShabdizEnabled } from "~lib/shabdiz"

const GRADIENT_BG =
  "radial-gradient(circle at 15% 10%, rgba(59, 130, 246, .18), transparent 30%), " +
  "radial-gradient(circle at 85% 85%, rgba(34, 197, 94, .10), transparent 32%), " +
  "linear-gradient(145deg, #05080d 0%, #0a1019 45%, #0d1420 100%)"

function IndexPopup() {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  // Set body to a solid dark color so the rounded inner div stands out.
  useEffect(() => {
    for (const el of [document.documentElement, document.body]) {
      el.style.background = "#030508"
      el.style.margin = "0"
      el.style.padding = "0"
    }
  }, [])

  useEffect(() => {
    isShabdizEnabled().then(setEnabled)

    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === "local" && SHABDIZ_ENABLED_KEY in changes) {
        setEnabled(changes[SHABDIZ_ENABLED_KEY].newValue !== false)
      }
    }

    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }, [])

  const toggle = () => {
    const next = enabled !== true
    setEnabled(next)
    chrome.storage.local.set({ [SHABDIZ_ENABLED_KEY]: next })
  }

  const isOn = enabled === true

  return (
    <div
      style={{
        padding: 25,
        minWidth: 260,
        fontFamily: "system-ui, sans-serif",
        background: GRADIENT_BG,
        color: "#e2e8f0"
      }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16, color: "#f1f5f9" }}>
        Shabdiz Download Manager
      </h2>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          cursor: "pointer",
          userSelect: "none"
        }}>
        <span style={{ fontSize: 14 }}>
          Download with Shabdiz{" "}
          <span
            style={{
              fontWeight: 600,
              fontSize: 12,
              color: isOn ? "#4ade80" : "#64748b"
            }}>
            {enabled === null ? "…" : isOn ? "ON" : "OFF"}
          </span>
        </span>

        <input
          type="checkbox"
          checked={isOn}
          disabled={enabled === null}
          onChange={toggle}
          style={{ display: "none" }}
        />
        <span
          aria-hidden="true"
          style={{
            position: "relative",
            width: 44,
            height: 24,
            flexShrink: 0,
            borderRadius: 24,
            background: isOn ? "#16a34a" : "#334155",
            transition: "background 0.2s"
          }}>
          <span
            style={{
              position: "absolute",
              top: 2,
              left: isOn ? 22 : 2,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "#f1f5f9",
              boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              transition: "left 0.2s"
            }}
          />
        </span>
      </label>

      <p style={{ margin: "12px 0 0", fontSize: 12, color: "#94a3b8" }}>
        {isOn
          ? "Downloads are sent to the Shabdiz app."
          : "Downloads are handled by the browser."}
      </p>
    </div>
  )
}

export default IndexPopup
