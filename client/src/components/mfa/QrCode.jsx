import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// Renders an otpauth:// (or any) string as a scannable QR code. The `qrcode`
// library draws to a canvas and hands back a PNG data-URL, which we drop into an
// <img> — self-contained, no network. If rendering fails (e.g. no canvas in the
// jsdom test env), we degrade silently; the manual-entry secret is always shown
// alongside by the caller, so enrollment still works.
export default function QrCode({ value, size = 200, label = 'Scan this QR code with your authenticator app' }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setDataUrl(null);
    setFailed(false);
    if (!value) return undefined;
    QRCode.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (alive) setDataUrl(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [value, size]);

  if (failed) return null;

  return (
    <div className="qr-code" style={{ width: size, height: size }}>
      {dataUrl ? (
        <img src={dataUrl} width={size} height={size} alt={label} />
      ) : (
        <span className="qr-code__placeholder" aria-hidden="true" />
      )}
    </div>
  );
}
