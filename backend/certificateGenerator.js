/**
 * Generates a professional SVG certificate
 */
function escapeXML(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>&"']/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
        }
    });
}

function generateCertificateSVG(studentName, courseName, universityName, date, certId) {
    const safeStudent = escapeXML(studentName);
    const safeCourse = escapeXML(courseName);
    const safeUni = escapeXML(universityName);

    return `
    <svg width="1000" height="700" viewBox="0 0 1000 700" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#D4AF37;stop-opacity:1" />
                <stop offset="50%" style="stop-color:#F9E29C;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#AF8A2C;stop-opacity:1" />
            </linearGradient>
        </defs>

        <!-- Main Background (Premium Dark) -->
        <rect width="1000" height="700" fill="#0f172a" />
        
        <!-- Elegant Outer Border -->
        <rect x="20" y="20" width="960" height="660" fill="none" stroke="url(#goldGrad)" stroke-width="4" />
        <rect x="35" y="35" width="930" height="630" fill="none" stroke="#D4AF37" stroke-width="1" stroke-dasharray="10,5" opacity="0.5" />
        
        <!-- Decorative Corners -->
        <path d="M20 100 V20 H100" fill="none" stroke="url(#goldGrad)" stroke-width="12" />
        <path d="M900 20 H980 V100" fill="none" stroke="url(#goldGrad)" stroke-width="12" />
        <path d="M20 600 V680 H100" fill="none" stroke="url(#goldGrad)" stroke-width="12" />
        <path d="M900 680 H980 V600" fill="none" stroke="url(#goldGrad)" stroke-width="12" />

        <!-- Header -->
        <text x="500" y="120" font-family="'Times New Roman', serif" font-size="48" font-weight="bold" fill="url(#goldGrad)" text-anchor="middle" letter-spacing="4">
            ${safeUni.toUpperCase()}
        </text>
        
        <line x1="300" y1="145" x2="700" y2="145" stroke="#D4AF37" stroke-width="2" opacity="0.6" />

        <text x="500" y="200" font-family="Arial, sans-serif" font-size="22" fill="#cbd5e1" text-anchor="middle" letter-spacing="8" font-weight="300">
            CERTIFICATE OF COMPLETION
        </text>
        
        <!-- Content -->
        <text x="500" y="270" font-family="'Times New Roman', serif" font-size="24" font-style="italic" fill="#94a3b8" text-anchor="middle">
            This is to certify that
        </text>
        
        <text x="500" y="340" font-family="'Times New Roman', serif" font-size="64" font-weight="bold" fill="#f8fafc" text-anchor="middle">
            ${safeStudent}
        </text>
        
        <text x="500" y="400" font-family="'Times New Roman', serif" font-size="24" font-style="italic" fill="#94a3b8" text-anchor="middle">
            has successfully completed all requirements for the professional course
        </text>
        
        <text x="500" y="470" font-family="Arial, sans-serif" font-size="36" font-weight="bold" fill="url(#goldGrad)" text-anchor="middle">
            ${safeCourse}
        </text>

        <!-- Seal / Logo Placeholder -->
        <circle cx="500" cy="565" r="45" fill="none" stroke="url(#goldGrad)" stroke-width="2" />
        <text x="500" y="572" font-family="serif" font-size="12" fill="#D4AF37" text-anchor="middle" font-weight="bold">OFFICIAL<tspan x="500" dy="12">SEAL</tspan></text>
        
        <!-- Signatures -->
        <g transform="translate(150, 600)">
            <line x1="0" y1="0" x2="200" y2="0" stroke="#94a3b8" stroke-width="1" />
            <text x="100" y="25" font-family="Arial, sans-serif" font-size="14" fill="#cbd5e1" text-anchor="middle">Academic Registrar</text>
            <text x="100" y="-10" font-family="'Brush Script MT', cursive" font-size="24" fill="#f8fafc" text-anchor="middle">John Doe</text>
        </g>

        <g transform="translate(650, 600)">
            <line x1="0" y1="0" x2="200" y2="0" stroke="#94a3b8" stroke-width="1" />
            <text x="100" y="25" font-family="Arial, sans-serif" font-size="14" fill="#cbd5e1" text-anchor="middle">Head of Instruction</text>
            <text x="100" y="-10" font-family="'Brush Script MT', cursive" font-size="24" fill="#f8fafc" text-anchor="middle">Nexlify Admin</text>
        </g>

        <!-- Metadata -->
        <text x="50" y="660" font-family="Monospace" font-size="10" fill="#64748b" text-anchor="start">
            Issue Date: ${date}
        </text>
        <text x="950" y="660" font-family="Monospace" font-size="10" fill="#64748b" text-anchor="end">
            Verify ID: ${certId}
        </text>
    </svg>
    `;
}

module.exports = { generateCertificateSVG };