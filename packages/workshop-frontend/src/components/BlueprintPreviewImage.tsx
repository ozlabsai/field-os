import { Hexagon } from '@phosphor-icons/react'
import { getGradient } from './BlueprintCard'

export function BlueprintPreviewImage({
  blueprintId,
  title,
  screenshotUrl,
  className,
}: {
  blueprintId: string
  title: string
  screenshotUrl?: string
  className?: string
}) {
  return (
    <div className={`overflow-hidden rounded-xl border border-kumo-line bg-kumo-tint ${className ?? ''}`}>
      {screenshotUrl ? (
        <img
          src={screenshotUrl}
          alt={`Screenshot of ${title}`}
          className="aspect-[16/9] w-full object-cover"
          loading="lazy"
        />
      ) : (
        <BlueprintPreviewPlaceholder id={blueprintId} title={title} />
      )}
    </div>
  )
}

export function BlueprintPreviewPlaceholder({ id, title }: { id: string; title?: string }) {
  // Deliberately not a mock document. This used to draw a header, a divider and five rows of four
  // columns -- a fake spreadsheet, identical for every blueprint, which made three unrelated
  // blueprints render as three identical grey documents and read as a loading skeleton that never
  // resolves. On this fork it never does resolve: screenshots require the BROWSER binding, which
  // standalone workerd does not have, so `metadata.screenshot` is never set and this placeholder is
  // the only thing anyone will ever see here.
  //
  // So show something true instead. The initials come from the blueprint's own title and the
  // gradient from its id, which makes each card distinguishable using data that actually exists,
  // and claims nothing about content that was never captured.
  // The *last* word, not the first letters of each. Measured against the titles this deployment
  // actually ships: first-letters gives "Workspace Slides" and "Workspace Sheets" both "WS", because
  // a shared leading word is the common case here. The trailing word is the distinguishing one.
  const words = (title ?? '').split(/\s+/).filter(Boolean)
  const last = words[words.length - 1] ?? ''
  const initials = last.slice(0, 2).replace(/^./, c => c.toUpperCase())

  return (
    <div className="relative aspect-[16/9] overflow-hidden bg-kumo-base">
      <div className={`absolute inset-0 bg-gradient-to-br ${getGradient(id)} opacity-25`} />
      <div className="absolute inset-0 grid place-items-center">
        {initials ? (
          <span
            aria-hidden="true"
            className="text-[44px] leading-none font-semibold tracking-[-1px] text-kumo-default/25 select-none"
          >
            {initials}
          </span>
        ) : (
          <Hexagon size={40} weight="bold" className="text-kumo-default/20" />
        )}
      </div>
    </div>
  )
}
