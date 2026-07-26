import type { Photo } from "@/lib/api";

export function PhotoGallery({ photos }: { photos: Photo[] }) {
  if (photos.length === 0) {
    return <p className="latestCaption">No photos for this filter.</p>;
  }

  return (
    <div className="photoGrid">
      {photos.map((p) => (
        <figure className="photoCard" key={p.id}>
          {p.signed_url ? (
            <img src={p.signed_url} alt={p.filename} loading="lazy" />
          ) : (
            <div className="photoUnavailable">Image unavailable</div>
          )}
          <figcaption>
            {p.device_id} &middot; {new Date(p.taken_at ?? p.received_at).toLocaleString()}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
