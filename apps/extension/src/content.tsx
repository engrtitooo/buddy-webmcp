import { createRoot } from 'react-dom/client'; import { BuddyApp } from '@buddy/buddy-ui'; import '@buddy/buddy-ui/styles.css'; import { WebMCPAdapter } from '@buddy/webmcp-bridge';

const HOST_ID='buddy-webmcp-companion-root';
if(!document.getElementById(HOST_ID)){
  const host=document.createElement('div');host.id=HOST_ID;host.setAttribute('data-buddy-extension','true');
  const shadow=host.attachShadow({mode:'closed'});const mount=document.createElement('div');shadow.append(mount);
  (document.documentElement||document.body).append(host);
  createRoot(mount).render(<BuddyApp adapter={new WebMCPAdapter()} siteName={location.hostname.replace(/^www\./,'')}/>);
}
