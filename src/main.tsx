import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import Landing from './Landing.tsx'
import { usePath } from './ui.tsx'

const Tool = lazy(() => import('./Tool.tsx'))

function App() {
  const path = usePath()
  if (path === '/app' || path.startsWith('/app/')) {
    return (
      <Suspense fallback={<div className="page-loading" role="status">Loading the lab</div>}>
        <Tool />
      </Suspense>
    )
  }
  return <Landing />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
