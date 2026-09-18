/* 中国移动品牌标识占位组件 */
/* 拿到正式品牌 SVG/PNG 资产后只替换此文件内部实现 */

export function BrandMark({ size = 40 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-label="中国移动">
      <rect width="40" height="40" rx="10" fill="#0085D0" />
      <path d="M12 20 L20 12 L28 20 L20 28 Z" fill="white" opacity="0.9" />
      <circle cx="20" cy="20" r="4" fill="white" />
    </svg>
  )
}

export function BrandText(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: '18px', fontWeight: 600, color: 'var(--cmcc-text)', letterSpacing: '1px' }}>
        中国移动
      </span>
      <span style={{ fontSize: '11px', color: 'var(--cmcc-text-secondary)' }}>
        CMCC Intelligent Agent Platform
      </span>
    </div>
  )
}