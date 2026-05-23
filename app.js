const state = {
  imageFile: null,
  imageUrl: "",
  googleAccessToken: "",
  googleTokenClient: null,
  googleClientId: localStorage.getItem("google-oauth-client-id") || "",
  boxes: {
    company: null,
    person: null,
    contact: null
  },
  boxDrag: null,
  contacts: JSON.parse(localStorage.getItem("business-card-contacts") || "[]")
};

const boxConfig = {
  company: {
    elementId: "companyBox",
    label: "회사",
    fieldIds: ["company"],
    fallback: { x: 0.08, y: 0.1, width: 0.46, height: 0.13 },
    psm: "7"
  },
  person: {
    elementId: "personBox",
    label: "사람 이름",
    fieldIds: ["name"],
    fallback: { x: 0.08, y: 0.24, width: 0.34, height: 0.14 },
    psm: "7"
  },
  contact: {
    elementId: "contactBox",
    label: "연락처",
    fieldIds: ["mobile", "phone", "email"],
    fallback: { x: 0.08, y: 0.5, width: 0.64, height: 0.24 },
    psm: "6"
  }
};

const fields = ["name", "company", "title", "mobile", "phone", "email", "website", "address", "notes"];
const $ = (id) => document.getElementById(id);

window.addEventListener("DOMContentLoaded", () => {
  if (window.lucide) {
    window.lucide.createIcons();
  }

  $("imageInput").addEventListener("change", handleImage);
  $("scanBtn").addEventListener("click", scanImage);
  $("parseBtn").addEventListener("click", () => fillForm(parseContact($("rawText").value)));
  $("clearBtn").addEventListener("click", resetCurrent);
  $("rescanBoxesBtn").addEventListener("click", rescanBoxes);
  $("saveBtn").addEventListener("click", saveContact);
  $("googleAuthBtn").addEventListener("click", connectGoogle);
  $("directSaveBtn").addEventListener("click", saveDirectlyToGoogle);
  $("saveClientIdBtn").addEventListener("click", saveGoogleClientId);
  $("csvBtn").addEventListener("click", exportGoogleCsv);
  $("vcfBtn").addEventListener("click", exportVCard);
  $("deleteAllBtn").addEventListener("click", deleteAllContacts);
  setupBoxInteraction();
  $("googleClientId").value = state.googleClientId;
  updateGoogleButtons();
  renderContacts();
});

function handleImage(event) {
  const [file] = event.target.files || [];
  if (!file) return;

  state.imageFile = file;
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  const url = URL.createObjectURL(file);
  state.imageUrl = url;
  const preview = $("preview");
  preview.src = url;
  $("previewFrame").classList.add("is-visible");
  preview.classList.add("is-visible");
  hideOcrBoxes();
  $("scanBtn").disabled = false;
  setStatus("사진이 준비되었습니다. 한글 강화 전처리 후 인식할 수 있습니다.", 0);
}

async function scanImage() {
  if (!state.imageFile) return;
  if (!window.Tesseract) {
    setStatus("OCR 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.", 0);
    return;
  }

  $("scanBtn").disabled = true;
  setStatus("명함 이미지를 한글 OCR에 맞게 보정하는 중입니다.", 4);

  let worker;
  try {
    const canvas = await preprocessImage(state.imageFile, {
      mode: $("ocrMode").value,
      scale: Number($("scaleMode").value || 3)
    });

    worker = await window.Tesseract.createWorker("kor+eng", 1, {
      logger: (message) => {
        if (message.status) {
          const progress = Math.round((message.progress || 0) * 100);
          setStatus(`${translateStatus(message.status)} ${progress}%`, progress);
        }
      }
    });

    await worker.setParameters({
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: "6",
      user_defined_dpi: "300"
    });

    setStatus("보정된 이미지에서 글자를 인식하는 중입니다.", 30);
    const result = await worker.recognize(canvas);
    const text = normalizeText(result.data.text);
    const contact = parseContact(text);
    $("rawText").value = text;
    fillForm(contact);
    showCandidateBoxes(result.data, contact, canvas);
    setStatus("인식 완료. 회사는 파란색, 사람 이름은 초록색, 연락처는 빨간색 박스로 표시했습니다. 틀리면 박스를 조절한 뒤 다시 인식하세요.", 100);
  } catch (error) {
    console.error(error);
    setStatus("인식에 실패했습니다. 작은 글자 선명 모드나 더 밝은 사진으로 다시 시도해 주세요.", 0);
  } finally {
    if (worker) {
      await worker.terminate();
    }
    $("scanBtn").disabled = false;
  }
}

async function preprocessImage(file, options) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.max(2, Math.min(4, options.scale || 3));
  const maxSide = 3200;
  const fit = Math.min(scale, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * fit);
  const height = Math.round(bitmap.height * fit);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);

  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const gray = new Uint8ClampedArray(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }

  const { low, high } = percentileRange(gray, options.mode === "soft" ? 0.01 : 0.02, options.mode === "soft" ? 0.99 : 0.985);
  const contrasted = new Uint8ClampedArray(gray.length);
  const span = Math.max(1, high - low);

  for (let i = 0; i < gray.length; i += 1) {
    const normalized = ((gray[i] - low) / span) * 255;
    contrasted[i] = clamp(normalized);
  }

  const sharpened = options.mode === "soft" ? contrasted : sharpen(contrasted, width, height, options.mode === "binary" ? 0.42 : 0.28);
  const finalGray = options.mode === "binary" ? adaptiveThreshold(sharpened, width, height) : sharpened;

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const value = finalGray[p];
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  bitmap.close();
  return canvas;
}

async function rescanBoxes() {
  if (!state.imageFile || !hasVisibleBoxes() || !window.Tesseract) return;

  $("rescanBoxesBtn").disabled = true;
  setStatus("모든 영역을 다시 인식하는 중입니다.", 10);

  try {
    for (const type of Object.keys(boxConfig)) {
      if (state.boxes[type]) {
        await rescanSingleBox(type, { updateButton: false, source: "manual" });
      }
    }
    setStatus("모든 영역을 다시 인식해 입력칸에 반영했습니다.", 100);
  } catch (error) {
    console.error(error);
    setStatus("영역 재인식에 실패했습니다. 박스를 글자에 조금 더 가깝게 맞춰 다시 시도해 주세요.", 0);
  } finally {
    $("rescanBoxesBtn").disabled = !hasVisibleBoxes();
  }
}

async function rescanSingleBox(type, options = {}) {
  const box = state.boxes[type];
  if (!state.imageFile || !box || !window.Tesseract) return;

  const config = boxConfig[type];
  const boxElement = $(config.elementId);
  if (options.updateButton !== false) {
    $("rescanBoxesBtn").disabled = true;
  }
  boxElement.classList.add("is-scanning");
  setStatus(`${config.label} 박스 안의 글자만 다시 인식하는 중입니다.`, 15);

  let worker;
  try {
    worker = await window.Tesseract.createWorker("kor+eng", 1, {
      logger: (message) => {
        if (message.status && options.updateButton !== false) {
          const progress = Math.round((message.progress || 0) * 100);
          setStatus(`${config.label} ${translateStatus(message.status)} ${progress}%`, progress);
        }
      }
    });

    await worker.setParameters({
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: config.psm,
      user_defined_dpi: "300"
    });

    const cropCanvas = await cropOriginalImage(state.imageFile, box, {
      scale: Number($("scaleMode").value || 3),
      mode: $("ocrMode").value
    });
    const result = await worker.recognize(cropCanvas);
    applyBoxText(type, result.data.text);

    if (options.updateButton !== false) {
      setStatus(`${config.label} 박스 안의 글자만 다시 인식해 해당 입력칸에 반영했습니다.`, 100);
    }
  } catch (error) {
    console.error(error);
    setStatus(`${config.label} 박스 재인식에 실패했습니다. 박스를 글자에 더 가깝게 맞춰 주세요.`, 0);
  } finally {
    if (worker) {
      await worker.terminate();
    }
    boxElement.classList.remove("is-scanning");
    if (options.updateButton !== false) {
      $("rescanBoxesBtn").disabled = !hasVisibleBoxes();
    }
  }
}

async function cropOriginalImage(file, box, options) {
  const bitmap = await createImageBitmap(file);
  const padX = 0.012;
  const padY = 0.018;
  const x = Math.max(0, (box.x - padX) * bitmap.width);
  const y = Math.max(0, (box.y - padY) * bitmap.height);
  const width = Math.min(bitmap.width - x, (box.width + padX * 2) * bitmap.width);
  const height = Math.min(bitmap.height - y, (box.height + padY * 2) * bitmap.height);
  const scale = Math.max(3, Math.min(5, (options.scale || 3) + 1));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(260, Math.round(width * scale));
  canvas.height = Math.max(90, Math.round(height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return preprocessImage(blob, { mode: options.mode, scale: 2 });
}

function applyBoxText(type, text) {
  if (type === "company") {
    const company = cleanCompanyText(text);
    if (company) $("company").value = company;
    setStatus(company ? `회사 박스에서 "${company}"을 인식했습니다.` : "회사 박스에서 글자를 읽지 못했습니다.", company ? 100 : 0);
    return;
  }

  if (type === "person") {
    const name = cleanNameText(text);
    if (name) $("name").value = name;
    setStatus(name ? `사람 박스에서 "${name}"을 인식했습니다.` : "사람 박스에서 이름을 읽지 못했습니다.", name ? 100 : 0);
    return;
  }

  const contact = parseContact(text);
  if (contact.mobile) $("mobile").value = contact.mobile;
  if (contact.phone) $("phone").value = contact.phone;
  if (contact.email) $("email").value = contact.email;
  const summary = [contact.mobile, contact.phone, contact.email].filter(Boolean).join(" / ");
  setStatus(summary ? `연락처 박스에서 ${summary}을 인식했습니다.` : "연락처 박스에서 연락처를 읽지 못했습니다.", summary ? 100 : 0);
}

function cleanCompanyText(text) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !/(Tel|Phone|Mobile|Email|www|http|주소|전화|팩스)/i.test(line));

  return stripCompanyNoise(lines[0] || "");
}

function cleanNameText(text) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.replace(/[^가-힣a-zA-Z.\s]/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !/(대표|이사|팀장|매니저|부장|차장|과장|CEO|CTO|Manager|Director|Founder|Tel|Mobile|Email)/i.test(line));

  return lines.find((line) => /^[가-힣]{2,5}(?:\s?[A-Z][a-z]+)?$/.test(line)) || lines[0] || "";
}

function showCandidateBoxes(ocrData, contact, canvas) {
  setOcrBox("company", findTextBox(ocrData, contact.company, canvas, isCompanyText) || boxConfig.company.fallback);
  setOcrBox("person", findTextBox(ocrData, contact.name, canvas, isPersonNameText) || boxConfig.person.fallback);
  setOcrBox("contact", findContactBox(ocrData, canvas) || boxConfig.contact.fallback);
}

function findTextBox(ocrData, target, canvas, fallbackPredicate) {
  const words = (ocrData.words || []).filter((word) => word.text && word.bbox);
  if (!words.length) return null;

  const cleanTarget = compactText(target);
  const candidates = words.filter((word) => {
    const text = compactText(word.text);
    if (!text) return false;
    return cleanTarget ? cleanTarget.includes(text) || text.includes(cleanTarget) : fallbackPredicate(word.text);
  });

  const selected = candidates.length ? candidates : words.filter((word) => fallbackPredicate(word.text)).slice(0, 2);
  if (!selected.length) return null;

  return wordBoxToNormalizedBox(selected, canvas);
}

function findContactBox(ocrData, canvas) {
  const words = (ocrData.words || []).filter((word) => word.text && word.bbox);
  const selected = words.filter((word) => /@|(?:\d[-.\s]?){7,}/.test(word.text));
  if (!selected.length) return null;
  return wordBoxToNormalizedBox(selected, canvas, 0.025, 0.035);
}

function wordBoxToNormalizedBox(words, canvas, marginXRatio = 0.015, marginYRatio = 0.02) {
  const merged = mergeWordBoxes(words);
  const marginX = canvas.width * marginXRatio;
  const marginY = canvas.height * marginYRatio;
  return normalizeBox({
    x: (merged.x0 - marginX) / canvas.width,
    y: (merged.y0 - marginY) / canvas.height,
    width: (merged.x1 - merged.x0 + marginX * 2) / canvas.width,
    height: (merged.y1 - merged.y0 + marginY * 2) / canvas.height
  });
}

function mergeWordBoxes(words) {
  return words.reduce((box, word) => ({
    x0: Math.min(box.x0, word.bbox.x0),
    y0: Math.min(box.y0, word.bbox.y0),
    x1: Math.max(box.x1, word.bbox.x1),
    y1: Math.max(box.y1, word.bbox.y1)
  }), { x0: Infinity, y0: Infinity, x1: 0, y1: 0 });
}

function compactText(value) {
  return String(value || "").replace(/[^가-힣a-zA-Z]/g, "");
}

function isCompanyText(value) {
  return /(주식회사|\(주\)|회사|Inc\.|Co\.|Ltd\.|LLC|Corp\.|Group|Labs|Studio)/i.test(value);
}

function isPersonNameText(value) {
  return /^[가-힣]{2,5}(?:\s?[A-Z][a-z]+)?$/.test(compactText(value));
}

function setOcrBox(type, box) {
  state.boxes[type] = normalizeBox(box);
  renderOcrBox(type);
  $("rescanBoxesBtn").disabled = false;
}

function hideOcrBoxes() {
  Object.keys(boxConfig).forEach((type) => {
    state.boxes[type] = null;
    $(boxConfig[type].elementId).classList.remove("is-visible");
  });
  $("rescanBoxesBtn").disabled = true;
}

function hasVisibleBoxes() {
  return Object.values(state.boxes).some(Boolean);
}

function renderOcrBox(type) {
  const selected = state.boxes[type];
  if (!selected) return;
  const box = $(boxConfig[type].elementId);
  box.style.left = `${selected.x * 100}%`;
  box.style.top = `${selected.y * 100}%`;
  box.style.width = `${selected.width * 100}%`;
  box.style.height = `${selected.height * 100}%`;
  box.classList.add("is-visible");
}

function normalizeBox(box) {
  const minWidth = 0.08;
  const minHeight = 0.06;
  const width = Math.min(0.95, Math.max(minWidth, box.width));
  const height = Math.min(0.95, Math.max(minHeight, box.height));
  const x = Math.min(1 - width, Math.max(0, box.x));
  const y = Math.min(1 - height, Math.max(0, box.y));
  return { x, y, width, height };
}

function setupBoxInteraction() {
  Object.keys(boxConfig).forEach((type) => {
    const box = $(boxConfig[type].elementId);
    box.addEventListener("pointerdown", (event) => {
      if (!state.boxes[type]) return;
      event.preventDefault();
      const frameRect = $("previewFrame").getBoundingClientRect();
      const handle = event.target.dataset.handle || "move";
      state.boxDrag = {
        type,
        handle,
        startX: event.clientX,
        startY: event.clientY,
        frameWidth: frameRect.width,
        frameHeight: frameRect.height,
        box: { ...state.boxes[type] },
        moved: false
      };
      box.setPointerCapture(event.pointerId);
    });

    box.addEventListener("pointermove", updateDraggedBox);
    box.addEventListener("pointerup", endBoxDrag);
    box.addEventListener("pointercancel", endBoxDrag);
  });
}

function updateDraggedBox(event) {
  if (!state.boxDrag) return;
  const drag = state.boxDrag;
  const dx = (event.clientX - drag.startX) / drag.frameWidth;
  const dy = (event.clientY - drag.startY) / drag.frameHeight;
  if (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002) {
    drag.moved = true;
  }
  let next = { ...drag.box };

  if (drag.handle === "move") {
    next.x += dx;
    next.y += dy;
  } else {
    if (drag.handle.includes("w")) {
      next.x += dx;
      next.width -= dx;
    }
    if (drag.handle.includes("e")) {
      next.width += dx;
    }
    if (drag.handle.includes("n")) {
      next.y += dy;
      next.height -= dy;
    }
    if (drag.handle.includes("s")) {
      next.height += dy;
    }
  }

  state.boxes[drag.type] = normalizeBox(next);
  renderOcrBox(drag.type);
}

function endBoxDrag() {
  const drag = state.boxDrag;
  state.boxDrag = null;
  if (drag?.moved) {
    rescanSingleBox(drag.type, { source: "drag" });
  }
}

function percentileRange(gray, lowPercent, highPercent) {
  const histogram = new Array(256).fill(0);
  gray.forEach((value) => {
    histogram[value] += 1;
  });

  const total = gray.length;
  const lowTarget = total * lowPercent;
  const highTarget = total * highPercent;
  let count = 0;
  let low = 0;
  let high = 255;

  for (let i = 0; i < histogram.length; i += 1) {
    count += histogram[i];
    if (count >= lowTarget) {
      low = i;
      break;
    }
  }

  count = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    count += histogram[i];
    if (count >= highTarget) {
      high = i;
      break;
    }
  }

  return { low, high };
}

function sharpen(source, width, height, amount) {
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        output[index] = source[index];
        continue;
      }

      const center = source[index] * (1 + amount * 4);
      const neighbors = (
        source[index - 1] +
        source[index + 1] +
        source[index - width] +
        source[index + width]
      ) * amount;
      output[index] = clamp(center - neighbors);
    }
  }
  return output;
}

function adaptiveThreshold(source, width, height) {
  const output = new Uint8ClampedArray(source.length);
  const radius = 12;
  const integral = new Uint32Array((width + 1) * (height + 1));

  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0;
    for (let x = 1; x <= width; x += 1) {
      rowSum += source[(y - 1) * width + (x - 1)];
      integral[y * (width + 1) + x] = integral[(y - 1) * (width + 1) + x] + rowSum;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const x1 = Math.max(0, x - radius);
      const y1 = Math.max(0, y - radius);
      const x2 = Math.min(width - 1, x + radius);
      const y2 = Math.min(height - 1, y + radius);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * (width + 1) + (x2 + 1)]
        - integral[y1 * (width + 1) + (x2 + 1)]
        - integral[(y2 + 1) * (width + 1) + x1]
        + integral[y1 * (width + 1) + x1];
      const mean = sum / area;
      output[y * width + x] = source[y * width + x] < mean - 8 ? 0 : 255;
    }
  }

  return output;
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function translateStatus(status) {
  const map = {
    "loading tesseract core": "OCR 코어 로딩",
    "initializing tesseract": "OCR 초기화",
    "loading language traineddata": "한글/영문 데이터 로딩",
    "initializing api": "분석 준비",
    "recognizing text": "글자 인식"
  };
  return map[status] || status;
}

function normalizeText(text) {
  return text
    .replace(/\r/g, "")
    .replace(/[|]/g, "I")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function parseContact(text) {
  const lines = normalizeText(text).split("\n");
  const joined = lines.join(" ");
  const email = firstMatch(joined, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const websiteLine = lines.find((line) => !line.includes("@") && /(?:https?:\/\/|www\.|[A-Z0-9-]+\.(?:com|net|org|co\.kr|kr|io|ai)\b)/i.test(line)) || "";
  const website = cleanWebsite(firstMatch(websiteLine, /(?:https?:\/\/)?(?:www\.)?[A-Z0-9-]+(?:\.[A-Z0-9-]+)+(?:\/[^\s]*)?/i));
  const phones = [...joined.matchAll(/(?:\+?\d{1,3}[-.\s]?)?(?:0\d{1,2}|\d{2,3})[-.\s]?\d{3,4}[-.\s]?\d{4}/g)]
    .map((match) => cleanPhone(match[0]))
    .filter(unique);

  const address = lines.find((line) => /\d/.test(line) && /(로|길|층|호|번지|Street|St\.|Road|Rd\.|Ave|Avenue)/i.test(line) && !line.includes("@")) || "";
  const companyLine = lines.find((line) => /(주식회사|\(주\)|회사|Inc\.|Co\.|Ltd\.|LLC|Corp\.|Group|Labs|Studio)/i.test(line)) || "";
  const titleLine = lines.find((line) => /(대표|이사|팀장|매니저|부장|차장|과장|실장|CEO|CTO|Manager|Director|Founder|Designer|Engineer)/i.test(line)) || "";
  const name = guessName(lines, [email, website, ...phones, address, companyLine, titleLine]);

  return {
    name,
    company: stripCompanyNoise(companyLine),
    title: titleLine,
    mobile: phones.find((phone) => /^01\d/.test(phone.replace(/\D/g, ""))) || phones[0] || "",
    phone: phones.find((phone) => !/^01\d/.test(phone.replace(/\D/g, ""))) || "",
    email: email || "",
    website: website || "",
    address,
    notes: text
  };
}

function guessName(lines, exclusions) {
  const blocked = exclusions.filter(Boolean).join(" ");
  const candidates = lines.filter((line) => {
    if (!line || blocked.includes(line)) return false;
    if (line.includes("@") || /\d{3,}/.test(line)) return false;
    if (/(www|http|Tel|Fax|Mobile|Phone|Email|주소|전화|팩스)/i.test(line)) return false;
    return line.length <= 24;
  });

  return candidates.find((line) => /^[가-힣]{2,5}(?:\s?[A-Z][a-z]+)?$/.test(line)) || candidates[0] || "";
}

function firstMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[0] : "";
}

function cleanPhone(phone) {
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
  if (digits.length === 10) return digits.replace(/(\d{2,3})(\d{3,4})(\d{4})/, "$1-$2-$3");
  return phone.trim();
}

function cleanWebsite(value) {
  if (!value || value.includes("@")) return "";
  return value.replace(/[),.]+$/, "");
}

function stripCompanyNoise(value) {
  return value.replace(/^(회사|Company)\s*[:：]?\s*/i, "").trim();
}

function unique(value, index, array) {
  return array.indexOf(value) === index;
}

function fillForm(contact) {
  fields.forEach((field) => {
    $(field).value = contact[field] || "";
  });
}

function readForm() {
  return fields.reduce((contact, field) => {
    contact[field] = $(field).value.trim();
    return contact;
  }, {});
}

function saveContact() {
  const contact = readForm();
  if (!contact.name && !contact.company && !contact.mobile && !contact.email) {
    setStatus("저장할 연락처 정보가 없습니다.", 0);
    return;
  }

  state.contacts.unshift({ ...contact, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
  persistContacts();
  renderContacts();
  setStatus("연락처 목록에 추가했습니다.", 100);
}

function saveGoogleClientId() {
  const clientId = $("googleClientId").value.trim();
  state.googleClientId = clientId;
  state.googleAccessToken = "";
  state.googleTokenClient = null;

  if (clientId) {
    localStorage.setItem("google-oauth-client-id", clientId);
    setStatus("Google Client ID를 저장했습니다. 이제 Google 권한 연결을 눌러 주세요.", 100);
  } else {
    localStorage.removeItem("google-oauth-client-id");
    setStatus("Google Client ID를 비웠습니다.", 0);
  }

  updateGoogleButtons();
}

function updateGoogleButtons() {
  $("googleAuthBtn").disabled = !state.googleClientId;
  $("directSaveBtn").disabled = !state.googleAccessToken;
}

async function connectGoogle() {
  if (!state.googleClientId) {
    setStatus("먼저 Google OAuth Client ID를 입력하고 저장해 주세요.", 0);
    return;
  }

  await loadGoogleIdentityScript();

  if (!window.google?.accounts?.oauth2) {
    setStatus("Google 로그인 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해 주세요.", 0);
    return;
  }

  state.googleTokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: state.googleClientId,
    scope: "https://www.googleapis.com/auth/contacts",
    callback: (response) => {
      if (response.error) {
        console.error(response);
        setStatus(`Google 권한 연결 실패: ${response.error}`, 0);
        return;
      }

      state.googleAccessToken = response.access_token;
      updateGoogleButtons();
      setStatus("Google 연락처 저장 권한이 연결되었습니다.", 100);
    }
  });

  state.googleTokenClient.requestAccessToken({ prompt: "consent" });
}

function loadGoogleIdentityScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();

  return new Promise((resolve) => {
    const existing = [...document.scripts].find((script) => script.src === "https://accounts.google.com/gsi/client");
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", resolve, { once: true });
      setTimeout(resolve, 2500);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = resolve;
    document.head.appendChild(script);
  });
}

async function saveDirectlyToGoogle() {
  const contact = readForm();
  if (!contact.name && !contact.company && !contact.mobile && !contact.email) {
    setStatus("Google 연락처에 저장할 정보가 없습니다.", 0);
    return;
  }

  if (!state.googleAccessToken) {
    setStatus("먼저 Google 권한 연결을 해 주세요.", 0);
    return;
  }

  $("directSaveBtn").disabled = true;
  setStatus("Google 연락처에 직접 저장하는 중입니다.", 35);

  try {
    const response = await fetch("https://people.googleapis.com/v1/people:createContact?personFields=names,organizations,phoneNumbers,emailAddresses,addresses,urls,biographies", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.googleAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(toGooglePerson(contact))
    });

    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        state.googleAccessToken = "";
        updateGoogleButtons();
      }
      throw new Error(result.error?.message || "Google 연락처 저장에 실패했습니다.");
    }

    setStatus("Google 연락처에 직접 저장했습니다.", 100);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Google 연락처 저장에 실패했습니다.", 0);
  } finally {
    updateGoogleButtons();
  }
}

function toGooglePerson(contact) {
  const person = {};
  if (contact.name) {
    person.names = [{ displayName: contact.name }];
  }
  if (contact.company || contact.title) {
    person.organizations = [{
      name: contact.company || undefined,
      title: contact.title || undefined
    }];
  }
  const phoneNumbers = [];
  if (contact.mobile) phoneNumbers.push({ value: contact.mobile, type: "mobile" });
  if (contact.phone) phoneNumbers.push({ value: contact.phone, type: "work" });
  if (phoneNumbers.length) person.phoneNumbers = phoneNumbers;
  if (contact.email) {
    person.emailAddresses = [{ value: contact.email, type: "work" }];
  }
  if (contact.address) {
    person.addresses = [{ formattedValue: contact.address, type: "work" }];
  }
  if (contact.website) {
    person.urls = [{ value: contact.website, type: "work" }];
  }
  if (contact.notes) {
    person.biographies = [{ value: contact.notes, contentType: "TEXT_PLAIN" }];
  }
  return person;
}

function renderContacts() {
  const list = $("contactsList");
  if (!state.contacts.length) {
    list.innerHTML = `<div class="contact-item"><p>저장된 명함이 없습니다.</p></div>`;
    return;
  }

  list.innerHTML = state.contacts.map((contact) => `
    <article class="contact-item">
      <div>
        <strong>${escapeHtml(contact.name || contact.company || "이름 없음")}</strong>
        <p>${escapeHtml([contact.company, contact.title].filter(Boolean).join(" · "))}</p>
        <p>${escapeHtml([contact.mobile, contact.phone, contact.email].filter(Boolean).join(" · "))}</p>
      </div>
      <div class="contact-actions">
        <button class="mini-button" type="button" data-load="${contact.id}">불러오기</button>
        <button class="mini-button" type="button" data-delete="${contact.id}">삭제</button>
      </div>
    </article>
  `).join("");

  list.querySelectorAll("[data-load]").forEach((button) => {
    button.addEventListener("click", () => {
      const contact = state.contacts.find((item) => item.id === button.dataset.load);
      if (contact) fillForm(contact);
    });
  });

  list.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      state.contacts = state.contacts.filter((item) => item.id !== button.dataset.delete);
      persistContacts();
      renderContacts();
    });
  });
}

function persistContacts() {
  localStorage.setItem("business-card-contacts", JSON.stringify(state.contacts));
}

function deleteAllContacts() {
  state.contacts = [];
  persistContacts();
  renderContacts();
}

function exportGoogleCsv() {
  const contacts = exportableContacts();
  const headers = [
    "Name",
    "Given Name",
    "Organization 1 - Name",
    "Organization 1 - Title",
    "Phone 1 - Type",
    "Phone 1 - Value",
    "Phone 2 - Type",
    "Phone 2 - Value",
    "E-mail 1 - Type",
    "E-mail 1 - Value",
    "Website 1 - Type",
    "Website 1 - Value",
    "Address 1 - Type",
    "Address 1 - Formatted",
    "Notes"
  ];

  const rows = contacts.map((contact) => [
    contact.name,
    contact.name,
    contact.company,
    contact.title,
    contact.mobile ? "Mobile" : "",
    contact.mobile,
    contact.phone ? "Work" : "",
    contact.phone,
    contact.email ? "Work" : "",
    contact.email,
    contact.website ? "Work" : "",
    contact.website,
    contact.address ? "Work" : "",
    contact.address,
    contact.notes
  ]);

  download(`google-contacts-${dateStamp()}.csv`, toCsv([headers, ...rows]), "text/csv;charset=utf-8");
}

function exportVCard() {
  const cards = exportableContacts().map((contact) => [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeVcf(contact.name || contact.company)}`,
    contact.company ? `ORG:${escapeVcf(contact.company)}` : "",
    contact.title ? `TITLE:${escapeVcf(contact.title)}` : "",
    contact.mobile ? `TEL;TYPE=CELL:${escapeVcf(contact.mobile)}` : "",
    contact.phone ? `TEL;TYPE=WORK:${escapeVcf(contact.phone)}` : "",
    contact.email ? `EMAIL;TYPE=WORK:${escapeVcf(contact.email)}` : "",
    contact.website ? `URL:${escapeVcf(contact.website)}` : "",
    contact.address ? `ADR;TYPE=WORK:;;${escapeVcf(contact.address)};;;;` : "",
    contact.notes ? `NOTE:${escapeVcf(contact.notes)}` : "",
    "END:VCARD"
  ].filter(Boolean).join("\n")).join("\n");

  download(`business-cards-${dateStamp()}.vcf`, cards, "text/vcard;charset=utf-8");
}

function exportableContacts() {
  const current = readForm();
  const hasCurrent = current.name || current.company || current.mobile || current.email;
  return hasCurrent ? [current, ...state.contacts] : state.contacts;
}

function toCsv(rows) {
  return rows.map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")).join("\n");
}

function escapeVcf(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function download(filename, content, type) {
  if (!content) {
    setStatus("내보낼 연락처가 없습니다.", 0);
    return;
  }

  const blob = new Blob(["\ufeff", content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function resetCurrent() {
  $("imageInput").value = "";
  $("preview").removeAttribute("src");
  $("preview").classList.remove("is-visible");
  $("previewFrame").classList.remove("is-visible");
  $("rawText").value = "";
  fillForm({});
  if (state.imageUrl) {
    URL.revokeObjectURL(state.imageUrl);
  }
  state.imageFile = null;
  state.imageUrl = "";
  hideOcrBoxes();
  $("scanBtn").disabled = true;
  setStatus("초기화했습니다.", 0);
}

function setStatus(text, progress) {
  $("statusText").textContent = text;
  $("progressBar").style.width = `${Math.max(0, Math.min(100, progress))}%`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
