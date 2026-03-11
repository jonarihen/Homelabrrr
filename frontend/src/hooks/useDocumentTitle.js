import { useEffect } from 'react';

export default function useDocumentTitle(title) {
  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} - VM Manager` : 'VM Manager';
    return () => { document.title = prev; };
  }, [title]);
}
