// Slow-drifting radial gradient mesh behind onboarding/unlock cards (spec §2.5).
// Pure CSS animation; the drift classes collapse under prefers-reduced-motion.

export function GradientMesh() {
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      <div
        className="sem-drift-a"
        style={{
          position: 'absolute',
          top: '-20%',
          left: '-10%',
          width: '70%',
          height: '90%',
          background: 'radial-gradient(circle at 40% 40%, var(--accent) 0%, transparent 65%)',
          opacity: 0.06,
        }}
      />
      <div
        className="sem-drift-b"
        style={{
          position: 'absolute',
          bottom: '-25%',
          right: '-15%',
          width: '75%',
          height: '95%',
          background: 'radial-gradient(circle at 60% 60%, var(--flare) 0%, transparent 65%)',
          opacity: 0.05,
        }}
      />
    </div>
  )
}
