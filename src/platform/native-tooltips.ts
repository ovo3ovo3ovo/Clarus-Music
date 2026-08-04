function removeNativeTitles(root: ParentNode): void {
  if (root instanceof Element) root.removeAttribute('title')
  for (const element of root.querySelectorAll('[title]')) element.removeAttribute('title')
}

export function installNativeTooltipBlocker(root: Element): () => void {
  removeNativeTitles(root)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        ;(record.target as Element).removeAttribute('title')
        continue
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) removeNativeTitles(node)
      }
    }
  })
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title'],
  })
  return () => observer.disconnect()
}
