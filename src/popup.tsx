import { useEffect, useState } from "react"
import { SHABDIZ_ENABLED_KEY, isShabdizEnabled } from "~lib/shabdiz"

function IndexPopup() {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    isShabdizEnabled().then(setEnabled)

    // Keep the switch in sync if the state changes elsewhere
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
        padding: 16,
        minWidth: 260,
        fontFamily: "system-ui, sans-serif",
        color: "#1f2937"
      }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Shabdiz Download Manager</h2>

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
              color: isOn ? "#16a34a" : "#6b7280"
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
            background: isOn ? "#16a34a" : "#d1d5db",
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
              background: "#fff",
              boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
              transition: "left 0.2s"
            }}
          />
        </span>
      </label>

      <p style={{ margin: "12px 0 0", fontSize: 12, color: "#6b7280" }}>
        {isOn
          ? "Downloads are sent to the Shabdiz app."
          : "Downloads are handled by the browser."}
      </p>
    </div>
  )
}

export default IndexPopup
