"use client";

import { useEffect, useState } from "react";
import type { Photo } from "@/lib/api";

export function PhotoGallery({ photos }: { photos: Photo[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    if (openIndex === null) return;

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenIndex(null);
      if (e.key === "ArrowRight") setOpenIndex((i) => (i === null ? i : Math.min(i + 1, photos.length - 1)));
      if (e.key === "ArrowLeft") setOpenIndex((i) => (i === null ? i : Math.max(i - 1, 0)));
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [openIndex, photos.length]);

  if (photos.length === 0) {
    return <p className="latestCaption">No photos for this filter.</p>;
  }

  const active = openIndex !== null ? photos[openIndex] : null;

  return (
    <>
      <div className="photoGrid">
        {photos.map((p, i) => (
          <figure className="photoCard" key={p.id}>
            {p.signed_url ? (
              <button
                type="button"
                className="photoOpenBtn"
                onClick={() => setOpenIndex(i)}
                aria-label={`View ${p.filename} larger`}
              >
                <img src={p.signed_url} alt={p.filename} loading="lazy" />
              </button>
            ) : (
              <div className="photoUnavailable">Image unavailable</div>
            )}
            <figcaption>
              {p.device_id} &middot; {new Date(p.taken_at ?? p.received_at).toLocaleString()}
            </figcaption>
          </figure>
        ))}
      </div>

      {active && (
        <div className="lightboxBackdrop" onClick={() => setOpenIndex(null)}>
          <button
            type="button"
            className="lightboxClose"
            onClick={() => setOpenIndex(null)}
            aria-label="Close"
          >
            ×
          </button>

          {openIndex! > 0 && (
            <button
              type="button"
              className="lightboxNav lightboxPrev"
              aria-label="Previous photo"
              onClick={(e) => {
                e.stopPropagation();
                setOpenIndex((i) => (i === null ? i : Math.max(i - 1, 0)));
              }}
            >
              ‹
            </button>
          )}

          <figure className="lightboxFigure" onClick={(e) => e.stopPropagation()}>
            {active.signed_url && <img src={active.signed_url} alt={active.filename} />}
            <figcaption>
              {active.device_id} &middot; {new Date(active.taken_at ?? active.received_at).toLocaleString()}
            </figcaption>
          </figure>

          {openIndex! < photos.length - 1 && (
            <button
              type="button"
              className="lightboxNav lightboxNext"
              aria-label="Next photo"
              onClick={(e) => {
                e.stopPropagation();
                setOpenIndex((i) => (i === null ? i : Math.min(i + 1, photos.length - 1)));
              }}
            >
              ›
            </button>
          )}
        </div>
      )}
    </>
  );
}
