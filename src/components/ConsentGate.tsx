import React, { useEffect, useState } from "react";
import {
  CONSENT_VERSION,
  getConsent,
  recordConsent,
  type ConsentRecord,
} from "@/lib/privacy/consent";

/**
 * Blocking onboarding screen that enforces informed consent before the user
 * can interact with any biometric capture surface (Ley 25.326, art. 5 & 7).
 *
 * Two independent checkboxes are required:
 *   1. Treatment of personal data.
 *   2. Capture of biometric data (PPG via camera).
 *
 * Until both are ticked, the "Continuar" button stays disabled. Until the
 * user accepts, no children render and no camera/sensor code can mount.
 */
const ConsentGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [consent, setConsent] = useState<ConsentRecord | null>(() => getConsent());
  const [acceptData, setAcceptData] = useState(false);
  const [acceptBio, setAcceptBio] = useState(false);

  // Re-evaluate on mount in case storage was cleared elsewhere.
  useEffect(() => {
    setConsent(getConsent());
  }, []);

  if (consent) return <>{children}</>;

  const canContinue = acceptData && acceptBio;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        color: "#fff",
        zIndex: 9999,
        overflowY: "auto",
        padding: "24px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div style={{ maxWidth: 560, width: "100%" }}>
        <h1 id="consent-title" style={{ fontSize: 22, marginBottom: 8 }}>
          Consentimiento informado
        </h1>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
          Versión {CONSENT_VERSION} · Ley Nº 25.326 (Argentina)
        </p>

        <section style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 16 }}>
          <p>
            Esta aplicación realiza mediciones de <strong>signos vitales</strong>{" "}
            mediante fotopletismografía (PPG) usando la cámara de su dispositivo.
            Los datos capturados son <strong>datos personales sensibles de
            naturaleza biométrica</strong>.
          </p>
          <p style={{ marginTop: 12 }}>
            <strong>Finalidad:</strong> estimación local de frecuencia cardíaca,
            calidad de señal y métricas derivadas para uso personal e
            investigación. Esta app <strong>no</strong> reemplaza al diagnóstico
            médico profesional.
          </p>
          <p style={{ marginTop: 12 }}>
            <strong>Tratamiento:</strong> el procesamiento ocurre en el
            dispositivo. Si decide guardar mediciones, los identificadores
            personales se anonimizan (rangos etarios, hash de IDs) antes de
            persistirse en el backend.
          </p>
          <p style={{ marginTop: 12 }}>
            <strong>Derechos:</strong> usted puede retirar su consentimiento en
            cualquier momento desde Ajustes &gt; Privacidad.
          </p>
        </section>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            marginBottom: 12,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={acceptData}
            onChange={(e) => setAcceptData(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            Presto mi <strong>consentimiento previo, expreso e informado</strong> al
            tratamiento de mis datos personales en los términos del art. 5 de la
            Ley 25.326.
          </span>
        </label>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            marginBottom: 20,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={acceptBio}
            onChange={(e) => setAcceptBio(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            Presto mi consentimiento al tratamiento de <strong>datos sensibles
            biométricos</strong> (PPG por cámara) conforme art. 7 de la Ley
            25.326.
          </span>
        </label>

        <button
          type="button"
          disabled={!canContinue}
          onClick={() => {
            const record = recordConsent();
            setConsent(record);
          }}
          style={{
            width: "100%",
            padding: "14px 20px",
            borderRadius: 10,
            border: "none",
            fontSize: 16,
            fontWeight: 600,
            cursor: canContinue ? "pointer" : "not-allowed",
            background: canContinue ? "#22c55e" : "#374151",
            color: "#fff",
            opacity: canContinue ? 1 : 0.6,
          }}
        >
          Continuar
        </button>

        <p style={{ fontSize: 11, opacity: 0.5, marginTop: 16, textAlign: "center" }}>
          Esta aplicación se encuentra en evaluación. No constituye un producto
          médico autorizado por ANMAT al día de la fecha.
        </p>
      </div>
    </div>
  );
};

export default ConsentGate;
