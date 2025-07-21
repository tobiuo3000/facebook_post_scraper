// Download an array of objects as CSV
function downloadCSV(dataArray) {
  if (!Array.isArray(dataArray) || dataArray.length === 0) return;

  const headers = Object.keys(dataArray[0]);
  const csvRows = [
    headers.join(","),
    ...dataArray.map(row =>
      headers.map(h =>
        `"${String(row[h]).replace(/"/g, '""')}"`
      ).join(",")
    )
  ];

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");

  a.style.display = "none";
  a.href     = url;
  a.download = "fb_posts.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Defer revoking so the download can start
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
