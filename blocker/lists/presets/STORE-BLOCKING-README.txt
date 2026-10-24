Browser-in-browser seed rules

IDs are exact matches, qualified with chrome:; other stores are not matched by the same ID.
Store terms are prefixed with store: and match listing slugs or tab titles of recognized extension detail pages only.
The words Browser and Firefox were intentionally NOT added by themselves because they would overblock unrelated extensions.

On startup, both existing and new installations merge these requested seed entries once into the active lists (only the Haukkis terms profile; IDs are global). Seed additions are queued individually for GitHub sync without replacing other entries. Removing a seed entry later does not automatically restore it. The two preset CSV files are provided for optional re-import through Merge.

For new installations, the same rules are seeded in the bundled fallback CSVs. Remote-first GitHub lists remain authoritative when configured.

This feature blocks detail page navigation when the background blocker sees its URL/title. It does not alter protected store DOM or prevent installation using browser enterprise policies. H1 or dropdown content cannot be inspected without allowed content-script access.
