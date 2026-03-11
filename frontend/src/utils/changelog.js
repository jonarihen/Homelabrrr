export function parseChangelog(markdown) {
  const entries = [];
  const lines = markdown.split(/\r?\n/);
  let currentEntry = null;
  let currentSection = null;

  const pushEntry = () => {
    if (!currentEntry) return;
    const firstSection = currentEntry.sections[0];
    const firstItem = firstSection?.items?.[0];
    currentEntry.summary = firstItem || currentEntry.title;
    entries.push(currentEntry);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === '---') continue;

    const entryMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+[—-]\s+(.+)$/);
    if (entryMatch) {
      pushEntry();
      currentEntry = {
        date: entryMatch[1],
        title: entryMatch[2],
        summary: '',
        sections: [],
      };
      currentSection = null;
      continue;
    }

    if (!currentEntry) continue;

    const sectionMatch = line.match(/^###\s+(.+)$/);
    if (sectionMatch) {
      currentSection = {
        heading: sectionMatch[1],
        items: [],
      };
      currentEntry.sections.push(currentSection);
      continue;
    }

    const bulletMatch = line.match(/^-\s+(.+)$/) || line.match(/^\d+\.\s+(.+)$/);
    if (bulletMatch) {
      if (!currentSection) {
        currentSection = {
          heading: 'Notes',
          items: [],
        };
        currentEntry.sections.push(currentSection);
      }
      currentSection.items.push(bulletMatch[1]);
    }
  }

  pushEntry();
  return entries;
}

