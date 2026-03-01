import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import SuperAdminApp from './SuperAdminApp'
import './App.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <SuperAdminApp />
  </StrictMode>
)