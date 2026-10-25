Browser-in-browser seed rules

IDs are exact matches, qualified with chrome:; other stores are not matched by the same ID.
Store terms are prefixed with store: and match listing slugs or tab titles of recognized extension detail pages, plus search phrases in Chrome Web Store /search/<phrase> URLs. Search phrases do not match against unrelated websites or tracking parameters.
The words Browser and Firefox were intentionally NOT added by themselves because they would overblock unrelated extensions.

On startup, both existing and new installations merge these requested seed entries once into the active lists (only the Haukkis terms profile; IDs are global). Seed additions are queued individually for GitHub sync without replacing other entries. Removing a seed entry later does not automatically restore it. The two preset CSV files are provided for optional re-import through Merge.

For new installations, the same rules are seeded in the bundled fallback CSVs. Remote-first GitHub lists remain authoritative when configured.

This feature blocks matching detail page navigation by URL/title and matching Chrome Web Store search URLs by their search phrase. It does not alter protected store DOM or prevent installation using browser enterprise policies. H1 or dropdown content cannot be inspected without allowed content-script access.

The Extension IDs page now includes a separate Blocked Extension Terms editor (add/remove/search/import/export).
This UI maintains store:phrase entries in the active profile's blockedTerms.csv, not a new CSV, for backward compatibility.
Global and store-only terms are shown separately; replace-import in either editor preserves the other.
Quick Block now has Add Extension Term. Existing rules and backups continue to work.

Navigation is checked again when committed/restored through Back/Forward history, including browser-tab activation. Store pages are checked using their URL/title metadata, not their restricted page DOM.
