import Link from "next/link";

interface Props {
  page: number;
  totalPages: number;
  buildHref: (page: number) => string;
}

export function Pagination({ page, totalPages, buildHref }: Props) {
  if (totalPages <= 1) return null;

  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;

  return (
    <nav className="pagination" aria-label="Pagination">
      {prevDisabled ? (
        <span className="pageBtn disabled">Prev</span>
      ) : (
        <Link className="pageBtn" href={buildHref(page - 1)}>
          Prev
        </Link>
      )}
      <span className="pageStatus">
        Page {page} of {totalPages}
      </span>
      {nextDisabled ? (
        <span className="pageBtn disabled">Next</span>
      ) : (
        <Link className="pageBtn" href={buildHref(page + 1)}>
          Next
        </Link>
      )}
    </nav>
  );
}
