import { supabase } from '../lib/supabase.js';
import { uploadToGoogleDrive } from '../lib/gdrive.js';

export default async function handler(req, res) {
  // 1. CORS CONFIGURATION (CRITICAL FOR HOSTINGER)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Only POST allowed' });

  const { action, payload, email, password, token } = req.body;
  
  try {
    let result = {};

    // 2. THE MASTER SWITCHBOARD
    switch (action) {
      
      // ==========================================
      // AUTHENTICATION
      // ==========================================
      case "login":
        const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
        if (authErr) throw authErr;
        
        // Fetch Profile
        const { data: profile } = await supabase.from('users').select('*').eq('auth_user_id', authData.user.id).single();
        if (profile.status !== 'Active') throw new Error("Account is disabled or pending.");

        result = { success: true, email: profile.email, token: authData.session.access_token, role: profile.role };
        break;

      case "changePassword":
        const { error: pwErr } = await supabase.auth.admin.updateUserById(payload.userId, { password: payload.newPassword });
        if (pwErr) throw pwErr;
        result = { success: true, message: "Password updated successfully!" };
        break;

      // ==========================================
      // DASHBOARD PAYLOAD
      // ==========================================
      case "getDashboardPayload":
        // 1. Validate JWT Token
        const { data: { user }, error: jwtErr } = await supabase.auth.getUser(token);
        if (jwtErr || !user) return res.status(401).json({ authFailed: true, message: "Session expired." });

        // 2. Fetch User & Institute joined data
        const { data: userData } = await supabase.from('users').select('*, institutes(*), operator_profiles(*)').eq('auth_user_id', user.id).single();
        
        // 3. Fetch Jobs
        const { data: jobs } = await supabase.from('jobs_queue').select('*').eq('institute_id', userData.institute_code).order('created_at', { ascending: false });

        // 4. Map to original payload structure
        result = {
          profile: {
            email: userData.email, name: userData.full_name, role: userData.role, 
            institute: userData.institutes?.institute_name, code: userData.institute_code,
            profilePic: userData.profile_pic_url,
            toggles: {
                attendance: userData.institutes?.attendance_toggle ? "YES" : "NO",
                admission: userData.institutes?.admission_toggle ? "YES" : "NO",
                fee: userData.institutes?.fee_toggle ? "YES" : "NO"
            },
            instDetails: { logoUrl: userData.institutes?.logo_url }
          },
          data: {
            papers: jobs.filter(j => j.job_type === 'Paper').map(j => ({ id: j.job_code, date: j.created_at, inst: userData.institutes?.institute_name, class: j.meta_data.class, subject: j.meta_data.subject, exam: j.meta_data.test_type, status: j.status, row: j.final_file_url })),
            docs: jobs.filter(j => j.job_type !== 'Paper').map(j => ({ id: j.job_code, date: j.created_at, inst: userData.institutes?.institute_name, class: j.meta_data.class, type: j.job_type, exam: j.meta_data.exam_name, students: j.meta_data.num_students, status: j.status, row: j.final_file_url }))
          },
          notifications: [], stats: {}, pricingMaster: []
        };
        break;

      // ==========================================
      // JOB UPLOADS (HYBRID: GDRIVE + SUPABASE)
      // ==========================================
      case "submitPaperJob":
        let paperDriveUrl = "";
        if (payload.fileBase64) {
            paperDriveUrl = await uploadToGoogleDrive(payload.fileBase64, payload.fileName, payload.mimeType);
        }
        
        const paperJobId = `TK-P-${Math.floor(1000 + Math.random() * 9000)}`;
        const { error: paperDbErr } = await supabase.from('jobs_queue').insert([{
            job_code: paperJobId, institute_id: payload.instCode, job_type: 'Paper',
            requester_id: payload.userId, status: 'Pending', raw_file_url: paperDriveUrl,
            meta_data: {
                class: payload.className, subject: payload.subject, test_type: payload.testType,
                full_marks: payload.fullMarks, pass_marks: payload.passMarks, duration: payload.duration,
                questions: payload.numQuestions, test_no: payload.testNo, test_date: payload.testDate
            }
        }]);
        if (paperDbErr) throw paperDbErr;
        result = { success: true, message: "Paper Processed.", jobId: paperJobId };
        break;

      case "submitDocumentJob":
        let docDriveUrl = "";
        if (payload.fileBase64) {
            docDriveUrl = await uploadToGoogleDrive(payload.fileBase64, payload.fileName, payload.mimeType);
        }
        
        const docJobId = `TK-D-${Math.floor(1000 + Math.random() * 9000)}`;
        const { error: docDbErr } = await supabase.from('jobs_queue').insert([{
            job_code: docJobId, institute_id: payload.instCode, job_type: payload.docType,
            requester_id: payload.userId, status: 'Pending', raw_file_url: docDriveUrl,
            meta_data: {
                class: payload.className, exam_name: payload.examName, num_students: payload.numStudents,
                announcement_date: payload.docDate, session: payload.docSession
            }
        }]);
        if (docDbErr) throw docDbErr;
        result = { success: true, message: "Document Processed.", jobId: docJobId };
        break;

      // ==========================================
      // REGISTRATIONS & MANAGEMENT
      // ==========================================
      case "submitInstituteRegistration":
        // 1. Insert Institute
        const { error: instErr } = await supabase.from('institutes').insert([{
            code: payload.instCode, institute_name: payload.instName, plan_type: payload.planType,
            logo_url: payload.logoUrl, is_active: true, attendance_toggle: payload.attendanceToggle === "YES",
            admission_toggle: payload.admissionToggle === "YES", fee_toggle: payload.feeToggle === "YES"
        }]);
        if (instErr) throw instErr;

        // 2. Create Auth User & Insert Admin Profile
        const { data: newAuthUser } = await supabase.auth.admin.createUser({ email: payload.adminEmail, password: "TKadmin123", email_confirm: true });
        await supabase.from('users').insert([{
            auth_user_id: newAuthUser.user.id, email: payload.adminEmail, full_name: payload.clientName || "Admin",
            role: 'admin', institute_code: payload.instCode, status: 'Active'
        }]);
        
        result = { success: true, message: "Institute & Admin Account Registered Successfully." };
        break;

      case "submitTeacherRegistration":
        const { data: tchrAuth } = await supabase.auth.admin.createUser({ email: payload.email, password: "TKtchr123", email_confirm: true });
        await supabase.from('users').insert([{
            auth_user_id: tchrAuth.user.id, email: payload.email, full_name: payload.name,
            role: 'teacher', institute_code: payload.instCode, status: 'Active', profile_pic_url: payload.photoUrl
        }]);
        result = { success: true, message: "Teacher added successfully!" };
        break;

      case "updateProfilePic":
        const { error: picErr } = await supabase.from('users').update({ profile_pic_url: payload.url }).eq('email', email);
        if (picErr) throw picErr;
        result = { success: true };
        break;

      default:
        throw new Error("Invalid API Action requested: " + action);
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error(error);
    return res.status(200).json({ success: false, message: error.message });
  }
}
