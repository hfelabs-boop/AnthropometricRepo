Attribute VB_Name = "AnthroApi"
Option Explicit
'
' Military anthropometry API from VBA (CATIA V5 / 3DEXPERIENCE VBA, AutoCAD VBA 7.x, Excel, Word ...).
' Import this file into the VBA editor (File > Import File). Needs Windows (MSXML 6 and Scripting.Dictionary).
' The file must keep its CRLF line endings (.gitattributes pins them); if the editor shows one long line, convert it to CRLF.
'
' NOT TESTED INSIDE CATIA OR AUTOCAD: it uses only standard Windows COM objects, but the sample at the bottom
' has only been checked by reading. Report problems with the exact error text.
'
' Set ANTHRO_BASE to your server (python -m anthro_service serve), e.g. http://myserver:8000
' If the server uses API keys, put the key in ANTHRO_KEY.

Public Const ANTHRO_BASE As String = "http://127.0.0.1:8000"
Public Const ANTHRO_KEY As String = ""

' Returns a Scripting.Dictionary: measure key (e.g. "stature") -> value as Double, in the measure's unit
' (millimetres for lengths, kg for mass, but check the unit attribute of the XML for others). `measures` is optional: "stature,mass,sitting_height" ; empty = every dimension.
' `survey` is optional: "latest" = the most recent survey only. Without it the values combine every survey, which can span decades.
Public Function AnthroMannequin(ByVal country As String, ByVal role As String, ByVal sex As String, _
                                ByVal percentile As Double, Optional ByVal measures As String = "", Optional ByVal survey As String = "") As Object
    Dim url As String
    url = ANTHRO_BASE & "/v1/mannequin?country=" & UrlEnc(country) & "&role=" & UrlEnc(role) & "&sex=" & UrlEnc(sex) & _
          "&percentile=" & Replace(CStr(percentile), ",", ".") & "&format=xml"
    If Len(measures) > 0 Then url = url & "&measures=" & UrlEnc(measures)
    If Len(survey) > 0 Then url = url & "&survey=" & UrlEnc(survey)   ' "latest" = the most recent survey only; default: all surveys combined

    Dim http As Object
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.Open "GET", url, False
    If Len(ANTHRO_KEY) > 0 Then http.setRequestHeader "X-API-Key", ANTHRO_KEY
    http.send
    If http.Status <> 200 Then Err.Raise vbObjectError + 513, "AnthroApi", "HTTP " & http.Status & ": " & http.responseText

    Dim doc As Object
    Set doc = CreateObject("MSXML2.DOMDocument.6.0")
    doc.async = False
    If Not doc.LoadXML(http.responseText) Then Err.Raise vbObjectError + 514, "AnthroApi", "Response is not XML"

    Dim result As Object, node As Object
    Set result = CreateObject("Scripting.Dictionary")
    For Each node In doc.SelectNodes("/mannequin/dimension")
        result(node.Attributes.getNamedItem("key").Text) = Val(node.Text)   ' Val always reads "." as the decimal mark
    Next
    Set AnthroMannequin = result
End Function

' Percent-encodes everything except letters, digits and - _ . ~ (ASCII names such as "Air Force" or "Recruits/trainees").
Private Function UrlEnc(ByVal s As String) As String
    Dim i As Long, c As String, out As String
    For i = 1 To Len(s)
        c = Mid$(s, i, 1)
        If c Like "[A-Za-z0-9._~-]" Then
            out = out & c
        Else
            out = out & "%" & Right$("0" & Hex$(Asc(c)), 2)
        End If
    Next
    UrlEnc = out
End Function

' Example: the P5, P50 and P95 stature and body mass of US Army men, printed to the Immediate window (Ctrl+G).
Public Sub AnthroDemo()
    Dim p As Variant, d As Object
    For Each p In Array(5, 50, 95)
        Set d = AnthroMannequin("United States", "Army", "M", CDbl(p), "stature,mass")
        Debug.Print "P" & p & ": stature " & d("stature") & " mm, mass " & d("mass") & " kg"
    Next
End Sub

' ---- Profiles pushed from the website (Digital human > Export > Send to CAD) ----------------------------------------------
' The website sends the body you built (its measures, the model's dimensions and its posture) to the server; these read it back.
' `id` is a profile id from GET /v1/profiles, or "latest" (default) for the one pushed last.

' Returns a Scripting.Dictionary: measure key (e.g. "stature", "sitting_height", "mass") -> value as Double. The same keys as AnthroMannequin,
' so a macro written for the population values works on a pushed profile. Units: millimetres for lengths, kg for mass (see AnthroProfileUnits).
Public Function AnthroProfile(Optional ByVal id As String = "latest") As Object
    Dim doc As Object, result As Object, node As Object
    Set doc = AnthroGetXml("/v1/profiles/" & UrlEnc(id) & "/values?format=xml")
    Set result = CreateObject("Scripting.Dictionary")
    For Each node In doc.SelectNodes("/profile/measure")
        result(node.Attributes.getNamedItem("key").Text) = Val(node.Text)
    Next
    Set AnthroProfile = result
End Function

' Measure key -> unit ("mm", "kg", "kg/m2" ...), for the same profile.
Public Function AnthroProfileUnits(Optional ByVal id As String = "latest") As Object
    Dim doc As Object, result As Object, node As Object, u As Object
    Set doc = AnthroGetXml("/v1/profiles/" & UrlEnc(id) & "/values?format=xml")
    Set result = CreateObject("Scripting.Dictionary")
    For Each node In doc.SelectNodes("/profile/measure")
        Set u = node.Attributes.getNamedItem("unit")
        If u Is Nothing Then result(node.Attributes.getNamedItem("key").Text) = "" Else result(node.Attributes.getNamedItem("key").Text) = u.Text
    Next
    Set AnthroProfileUnits = result
End Function

' The posture: "joint.dof" (e.g. "knee_L.flex", "shoulder_R.abd", "root.heading") -> angle in degrees, for every degree of freedom of the website's rig.
Public Function AnthroProfileAngles(Optional ByVal id As String = "latest") As Object
    Dim doc As Object, result As Object, node As Object
    Set doc = AnthroGetXml("/v1/profiles/" & UrlEnc(id) & "/angles?format=xml")
    Set result = CreateObject("Scripting.Dictionary")
    For Each node In doc.SelectNodes("/profile/row")
        result(node.Attributes.getNamedItem("joint_id").Text & "." & node.Attributes.getNamedItem("dof_key").Text) = Val(node.Attributes.getNamedItem("value_deg").Text)
    Next
    Set AnthroProfileAngles = result
End Function

' CATIA V5: copy the pushed profile onto the Knowledge parameters of the active part that are named like the measure keys
' (for example a Length parameter "stature" and a Mass parameter "mass"). Parameters that do not exist are skipped and listed in the Immediate window.
' Rename the keys in MAPPING-style code of your own if your manikin or skeleton parameters have other names.
Public Sub AnthroProfileToParameters(Optional ByVal id As String = "latest")
    Dim values As Object, units As Object, params As Object, k As Variant, suffix As String, p As Object
    Set values = AnthroProfile(id)
    Set units = AnthroProfileUnits(id)
    Set params = CATIA.ActiveDocument.Part.Parameters
    For Each k In values.Keys
        Select Case units(k)
            Case "mm": suffix = "mm"
            Case "kg": suffix = "kg"
            Case Else: suffix = ""
        End Select
        Set p = Nothing
        On Error Resume Next
        Set p = params.Item(CStr(k))
        On Error GoTo 0
        If p Is Nothing Then
            Debug.Print "no parameter " & k
        ElseIf Len(suffix) > 0 Then
            p.ValuateFromString Replace(CStr(values(k)), ",", ".") & suffix
        Else
            p.Value = values(k)
        End If
    Next
End Sub

' Example: the stature, sitting height and knee angle of the profile pushed last, printed to the Immediate window (Ctrl+G).
Public Sub AnthroProfileDemo()
    Dim d As Object, a As Object
    Set d = AnthroProfile("latest")
    Set a = AnthroProfileAngles("latest")
    Debug.Print "stature " & d("stature") & " mm, sitting height " & d("sitting_height") & " mm, mass " & d("mass") & " kg"
    Debug.Print "left knee flexion " & a("knee_L.flex") & " deg, right hip flexion " & a("hip_R.flex") & " deg"
End Sub

Private Function AnthroGetXml(ByVal path As String) As Object
    Dim http As Object, doc As Object
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.Open "GET", ANTHRO_BASE & path, False
    If Len(ANTHRO_KEY) > 0 Then http.setRequestHeader "X-API-Key", ANTHRO_KEY
    http.send
    If http.Status <> 200 Then Err.Raise vbObjectError + 513, "AnthroApi", "HTTP " & http.Status & ": " & http.responseText
    Set doc = CreateObject("MSXML2.DOMDocument.6.0")
    doc.async = False
    If Not doc.LoadXML(http.responseText) Then Err.Raise vbObjectError + 514, "AnthroApi", "Response is not XML"
    Set AnthroGetXml = doc
End Function
