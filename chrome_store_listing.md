# Name Checker - Chrome Web Store Listing Details

*Use the following details to fill out your Chrome Web Store listing page.*

---

## 📌 Basic Information

**Title:** Name Checker  
**Summary:** Instantly and automatically compare names across different tabs and sections of your dashboard to detect mismatches.  
**Category:** Productivity  
**Language:** English  

---

## 📝 Description

**Name Checker** is a fast, lightweight automation tool designed to streamline data verification workflows. It eliminates the need for manual cross-checking by automatically extracting and validating names as you navigate through your web applications.

### ✨ Key Features:
*   **Smart Cross-Tab Memory:** Automatically captures a primary name on one page and seamlessly remembers it to verify against records on different tabs.
*   **Advanced Name Matching:** Built to handle complex name structures natively. It easily understands abbreviations, missing middle names, and swapped word orders without flagging false errors.
*   **Real-time Monitoring:** A sleek, non-intrusive floating status badge tracks your checks in real-time, instantly alerting you with a clear ✅ Match or ❌ Mismatch—no extra clicks required.
*   **High-Accuracy Extraction:** Uses intelligent algorithms to target exactly the data you need while completely ignoring irrelevant surrounding text.
*   **Dark-Mode Native UI:** A beautifully designed popup dashboard featuring smooth glassmorphism and modern aesthetics.

### 🚀 How to use:
1. Open the **Profile** tab of your dashboard. The extension will silently capture and save the NSDL Profile Name.
2. Navigate to the **Emp Info** tab and scroll to the Bank Statement section.
3. The extension will automatically verify the *Acc holder's name* against the saved profile name and instantly highlight the result in Green (Match), Orange (Partial Match), or Red (Mismatch).

*Stop wasting time manually comparing names character by character. Let Name Checker automate the validation process for you!*

---

## 🎨 Graphic Assets Requirements

*Make sure you prepare these image files before publishing:*

*   **Store Icon:** `128x128` pixels (You can use the `icon128.png` I generated for you!)
*   **Screenshots:** At least 1 is required. Must be exactly `1280x800` or `640x400` pixels (JPEG or PNG). *Tip: Take a screenshot of the green ✅ match working on the screen alongside the popup!*
*   **Small Promo Tile:** `440x280` pixels.
*   **Marquee Promo Tile:** `1400x560` pixels.

---

## ⚙️ Additional Fields

*   **Mature Content:** No
*   **Homepage URL:** *(Leave blank or link to your portfolio/company website)*
*   **Support URL:** *(Leave blank or link to an email/issue tracker)*

---

## 🔒 Privacy Tab Answers

*Use these exact texts to fill out the "Privacy" tab in the Developer Dashboard.*

**Single purpose description:**
This extension is designed to automatically verify and compare names displayed on web pages across different tabs to help users quickly detect data entry mismatches without manually checking.

**Permission Justifications:**
*   **storage:** Required to temporarily save the extracted profile name locally on the user's device so it can be compared when the user navigates to a different tab.
*   **activeTab:** Required to interact with the current tab the user is viewing so the extension popup can display the current scanning status.
*   **scripting:** Required to execute the content script that visually highlights matching or mismatching names directly on the webpage.
*   **Host permission justification (`<all_urls>`):** The extension needs to scan text and inject highlights across various internal dashboards and unknown URL structures that users might use for their specific data verification tasks.

**Are you using remote code?**
*   Select: **No, I am not using Remote code**

**Data usage:**
*   *What user data do you plan to collect?* Leave all boxes **unchecked**. The extension does not collect, store, or transmit any user data to external servers. All name verification happens strictly offline and locally on the user's device.
*   *I certify that the following disclosures are true:* Check **all three boxes**.
